import type { FinanceContext } from "./financeContext";

interface TransactionMatchRow {
  account_name: string;
  amount: number;
  currency_code: string | null;
  id: string;
  merchant_name: string | null;
  name: string;
  transaction_date: string;
}

const maxQueryLength = 100;
const resultLimit = 25;

/**
 * Finds imported transactions by name, merchant, or amount so another
 * record, such as an inbox email, can be linked to one. Without a query it
 * returns the most recent transactions.
 */
export async function searchTransactions(context: FinanceContext) {
  const query = (context.req.query("q") ?? "").trim();
  if (query.length > maxQueryLength) {
    return context.json(
      { error: `Searches need ${maxQueryLength} characters or fewer.` },
      400,
    );
  }
  const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
  const amount = amountFrom(query);
  const result = await context.env.DB.prepare(
    `SELECT txn.id, txn.name, txn.merchant_name, txn.amount,
            txn.currency_code, txn.transaction_date,
            account.name AS account_name
     FROM plaid_transactions AS txn
     JOIN plaid_accounts AS account ON account.id = txn.account_record_id
     WHERE txn.organization_id = ? AND txn.source_status = 'active'
       AND (
         ? = ''
         OR txn.name LIKE ? ESCAPE '\\'
         OR txn.merchant_name LIKE ? ESCAPE '\\'
         OR (? IS NOT NULL AND abs(abs(txn.amount) - ?) < 0.005)
       )
     ORDER BY txn.transaction_date DESC, txn.id DESC
     LIMIT ?`,
  )
    .bind(
      context.get("organizationId"),
      query,
      pattern,
      pattern,
      amount,
      amount,
      resultLimit,
    )
    .all<TransactionMatchRow>();
  return context.json({ transactions: result.results.map(toMatch) });
}

/** "42.75", "$42.75", or "1,042" as an unsigned amount; otherwise null. */
function amountFrom(query: string) {
  const normalized = query.replace(/^\$/, "").replaceAll(",", "");
  return /^\d+(\.\d{1,2})?$/.test(normalized) ? Number(normalized) : null;
}

function toMatch(row: TransactionMatchRow) {
  return {
    accountName: row.account_name,
    amount: row.amount,
    currencyCode: row.currency_code,
    id: row.id,
    merchantName: row.merchant_name,
    name: row.name,
    transactionDate: row.transaction_date,
  };
}
