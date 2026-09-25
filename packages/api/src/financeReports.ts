import type { FinanceContext } from "./financeContext";

/*
 * Expense reporting rules (Plaid amounts are positive for money leaving an
 * account and negative for money arriving):
 * - Only posted, active transactions count; pending ones can still change.
 * - A transaction assigned an expense category always counts toward it, so
 *   refunds assigned to a category reduce that category's total.
 * - Unassigned outflows count as uncategorized expenses, except transfers
 *   and loan or card payments, which would double-count spending already
 *   imported from the other account. Those are totalled separately.
 * - Unassigned inflows (income, refunds) are not expenses.
 * Amounts are grouped by currency and never summed across currencies.
 */
const transferCategories = ["TRANSFER_OUT", "LOAN_PAYMENTS"];

const reportFilter = `txn.organization_id = ?
         AND txn.source_status = 'active'
         AND txn.pending = 0
         AND (? IS NULL OR txn.transaction_date >= ?)
         AND (? IS NULL OR txn.transaction_date <= ?)`;

interface ExpenseRow {
  category_id: string | null;
  currency: string;
  total: number;
  transaction_count: number;
}

interface TransferRow {
  currency: string;
  total: number;
  transaction_count: number;
}

interface CategoryTotal {
  id: string | null;
  name: string;
  total: number;
  transactionCount: number;
}

interface ReportRange {
  from: string | null;
  to: string | null;
}

export async function expenseReport(context: FinanceContext) {
  const range = reportRange(context.req.query("from"), context.req.query("to"));
  if (!range) {
    return context.json(
      { error: "Use YYYY-MM-DD dates with from on or before to." },
      400,
    );
  }
  const database = context.env.DB;
  const organizationId = context.get("organizationId");
  const [expenses, transfers, categories] = await Promise.all([
    expenseRows(database, organizationId, range),
    transferRows(database, organizationId, range),
    database
      .prepare(
        `SELECT id, name FROM finance_expense_categories
         WHERE organization_id = ? ORDER BY name COLLATE NOCASE ASC`,
      )
      .bind(organizationId)
      .all<{ id: string; name: string }>(),
  ]);
  return context.json({
    currencies: summarizeExpenses(expenses, transfers, categories.results),
    from: range.from,
    to: range.to,
  });
}

/** Builds per-currency totals; every category appears, even at zero. */
function summarizeExpenses(
  expenses: ExpenseRow[],
  transfers: TransferRow[],
  categories: { id: string; name: string }[],
) {
  const currencies = [
    ...new Set([
      ...expenses.map((row) => row.currency),
      ...transfers.map((row) => row.currency),
    ]),
  ].sort();
  return currencies.map((currency) => {
    const rows = expenses.filter((row) => row.currency === currency);
    const totals: CategoryTotal[] = categories.map((category) =>
      categoryTotal(category.id, category.name, rows),
    );
    const uncategorized = categoryTotal(null, "Uncategorized", rows);
    if (uncategorized.transactionCount > 0) totals.push(uncategorized);
    totals.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    const transfer = transfers.find((row) => row.currency === currency);
    return {
      categories: totals,
      currency,
      excludedTransfers: {
        total: cents(transfer?.total ?? 0),
        transactionCount: transfer?.transaction_count ?? 0,
      },
      total: cents(rows.reduce((sum, row) => sum + row.total, 0)),
      transactionCount: rows.reduce(
        (sum, row) => sum + row.transaction_count,
        0,
      ),
    };
  });
}

function reportRange(
  from: string | undefined,
  to: string | undefined,
): ReportRange | null {
  const start = from || null;
  const end = to || null;
  if ((start && !isDate(start)) || (end && !isDate(end))) return null;
  if (start && end && start > end) return null;
  return { from: start, to: end };
}

async function expenseRows(
  database: D1Database,
  organizationId: string,
  range: ReportRange,
) {
  const result = await database
    .prepare(
      `SELECT COALESCE(txn.currency_code, '') AS currency,
              annotation.expense_category_id AS category_id,
              ROUND(SUM(txn.amount), 2) AS total,
              COUNT(*) AS transaction_count
       FROM plaid_transactions AS txn
       LEFT JOIN finance_transaction_annotations AS annotation
         ON annotation.transaction_id = txn.id
       WHERE ${reportFilter}
         AND (annotation.expense_category_id IS NOT NULL
           OR (txn.amount > 0
             AND COALESCE(txn.category_primary, '') NOT IN (?, ?)))
       GROUP BY currency, category_id`,
    )
    .bind(...filterBindings(organizationId, range), ...transferCategories)
    .all<ExpenseRow>();
  return result.results;
}

async function transferRows(
  database: D1Database,
  organizationId: string,
  range: ReportRange,
) {
  const result = await database
    .prepare(
      `SELECT COALESCE(txn.currency_code, '') AS currency,
              ROUND(SUM(txn.amount), 2) AS total,
              COUNT(*) AS transaction_count
       FROM plaid_transactions AS txn
       LEFT JOIN finance_transaction_annotations AS annotation
         ON annotation.transaction_id = txn.id
       WHERE ${reportFilter}
         AND annotation.expense_category_id IS NULL
         AND txn.amount > 0
         AND txn.category_primary IN (?, ?)
       GROUP BY currency`,
    )
    .bind(...filterBindings(organizationId, range), ...transferCategories)
    .all<TransferRow>();
  return result.results;
}

function filterBindings(organizationId: string, range: ReportRange) {
  return [organizationId, range.from, range.from, range.to, range.to];
}

function categoryTotal(
  id: string | null,
  name: string,
  rows: ExpenseRow[],
): CategoryTotal {
  const matching = rows.filter((row) => row.category_id === id);
  return {
    id,
    name,
    total: cents(matching.reduce((sum, row) => sum + row.total, 0)),
    transactionCount: matching.reduce(
      (sum, row) => sum + row.transaction_count,
      0,
    ),
  };
}

function isDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().startsWith(value);
}

function cents(value: number) {
  return Math.round(value * 100) / 100;
}
