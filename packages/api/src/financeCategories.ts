import type { FinanceContext } from "./financeContext";

interface CategoryRow {
  id: string;
  name: string;
  transaction_count: number;
}

const maxCategoryNameLength = 60;

/** Offered in one click to organizations that have no categories yet. */
const defaultExpenseCategories = [
  "Advertising and marketing",
  "Bank and processing fees",
  "Contractors",
  "Equipment",
  "Insurance",
  "Meals",
  "Office supplies",
  "Payroll",
  "Professional services",
  "Rent and utilities",
  "Software and subscriptions",
  "Taxes and licenses",
  "Travel",
  "Vehicle and fuel",
] as const;

export async function listExpenseCategories(
  database: D1Database,
  organizationId: string,
) {
  const result = await database
    .prepare(
      `SELECT category.id, category.name,
              COUNT(txn.id) AS transaction_count
       FROM finance_expense_categories AS category
       LEFT JOIN finance_transaction_annotations AS annotation
         ON annotation.expense_category_id = category.id
       LEFT JOIN plaid_transactions AS txn
         ON txn.id = annotation.transaction_id
        AND txn.source_status = 'active'
       WHERE category.organization_id = ?
       GROUP BY category.id
       ORDER BY category.name COLLATE NOCASE ASC`,
    )
    .bind(organizationId)
    .all<CategoryRow>();
  return result.results.map(toCategory);
}

export async function listCategories(context: FinanceContext) {
  return context.json({
    categories: await listExpenseCategories(
      context.env.DB,
      context.get("organizationId"),
    ),
  });
}

export async function createCategory(context: FinanceContext) {
  const name = await categoryName(context);
  if (!name) return invalidName(context);
  const organizationId = context.get("organizationId");
  if (await nameTaken(context.env.DB, organizationId, name)) {
    return duplicateName(context);
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await context.env.DB.prepare(
    `INSERT INTO finance_expense_categories
       (id, organization_id, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id, organizationId, name, now, now)
    .run();
  return context.json({ category: { id, name, transactionCount: 0 } }, 201);
}

export async function renameCategory(context: FinanceContext) {
  const id = context.req.param("id");
  const name = await categoryName(context);
  if (!name) return invalidName(context);
  const organizationId = context.get("organizationId");
  if (!id || !(await findCategory(context.env.DB, organizationId, id))) {
    return categoryNotFound(context);
  }
  if (await nameTaken(context.env.DB, organizationId, name, id)) {
    return duplicateName(context);
  }
  await context.env.DB.prepare(
    `UPDATE finance_expense_categories SET name = ?, updated_at = ?
     WHERE id = ? AND organization_id = ?`,
  )
    .bind(name, new Date().toISOString(), id, organizationId)
    .run();
  return context.json({ category: { id, name } });
}

export async function deleteCategory(context: FinanceContext) {
  const id = context.req.param("id");
  const organizationId = context.get("organizationId");
  if (!id || !(await findCategory(context.env.DB, organizationId, id))) {
    return categoryNotFound(context);
  }
  // Unassign explicitly rather than relying on the foreign-key action alone.
  await context.env.DB.batch([
    context.env.DB.prepare(
      `UPDATE finance_transaction_annotations SET expense_category_id = NULL
       WHERE organization_id = ? AND expense_category_id = ?`,
    ).bind(organizationId, id),
    context.env.DB.prepare(
      `DELETE FROM finance_expense_categories
       WHERE id = ? AND organization_id = ?`,
    ).bind(id, organizationId),
  ]);
  return context.body(null, 204);
}

export async function addDefaultCategories(context: FinanceContext) {
  const organizationId = context.get("organizationId");
  const now = new Date().toISOString();
  await context.env.DB.batch(
    defaultExpenseCategories.map((name) =>
      context.env.DB.prepare(
        `INSERT OR IGNORE INTO finance_expense_categories
           (id, organization_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), organizationId, name, now, now),
    ),
  );
  return listCategories(context);
}

/** Sets or clears a transaction's single expense category. */
export async function assignTransactionCategory(context: FinanceContext) {
  const transactionId = context.req.param("id");
  const input: unknown = await context.req.json().catch(() => null);
  const categoryId = categoryIdFrom(input);
  if (!transactionId || categoryId === undefined) {
    return context.json({ error: "A category or null is required." }, 400);
  }
  const organizationId = context.get("organizationId");
  const database = context.env.DB;
  const transaction = await database
    .prepare(
      `SELECT id FROM plaid_transactions WHERE id = ? AND organization_id = ?`,
    )
    .bind(transactionId, organizationId)
    .first<{ id: string }>();
  if (!transaction) {
    return context.json({ error: "Transaction not found." }, 404);
  }
  if (
    categoryId &&
    !(await findCategory(database, organizationId, categoryId))
  ) {
    return categoryNotFound(context);
  }
  const now = new Date().toISOString();
  const userId = context.get("authSession").user.id;
  await database
    .prepare(
      `INSERT INTO finance_transaction_annotations
         (transaction_id, organization_id, note, labels, reviewed,
          expense_category_id, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, '', '[]', 0, ?, ?, ?, ?, ?)
       ON CONFLICT(transaction_id) DO UPDATE SET
         expense_category_id = excluded.expense_category_id,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    )
    .bind(transactionId, organizationId, categoryId, userId, userId, now, now)
    .run();
  return context.json({ expenseCategoryId: categoryId });
}

async function findCategory(
  database: D1Database,
  organizationId: string,
  id: string,
) {
  return database
    .prepare(
      `SELECT id FROM finance_expense_categories
       WHERE id = ? AND organization_id = ?`,
    )
    .bind(id, organizationId)
    .first<{ id: string }>();
}

async function nameTaken(
  database: D1Database,
  organizationId: string,
  name: string,
  exceptId?: string,
) {
  const existing = await database
    .prepare(
      `SELECT id FROM finance_expense_categories
       WHERE organization_id = ? AND name = ? COLLATE NOCASE`,
    )
    .bind(organizationId, name)
    .first<{ id: string }>();
  return Boolean(existing && existing.id !== exceptId);
}

async function categoryName(context: FinanceContext) {
  const input: unknown = await context.req.json().catch(() => null);
  if (typeof input !== "object" || input === null) return null;
  const name = Reflect.get(input, "name");
  if (typeof name !== "string") return null;
  const trimmed = name.trim().replace(/\s+/g, " ");
  return trimmed && trimmed.length <= maxCategoryNameLength ? trimmed : null;
}

/** A category id, null to clear, or undefined when the input is invalid. */
function categoryIdFrom(input: unknown) {
  if (typeof input !== "object" || input === null) return undefined;
  const categoryId = Reflect.get(input, "categoryId");
  if (categoryId === null) return null;
  return typeof categoryId === "string" &&
    categoryId.length > 0 &&
    categoryId.length <= 100
    ? categoryId
    : undefined;
}

function toCategory(row: CategoryRow) {
  return {
    id: row.id,
    name: row.name,
    transactionCount: row.transaction_count,
  };
}

function invalidName(context: FinanceContext) {
  return context.json(
    {
      error: `Category names need 1 to ${maxCategoryNameLength} characters.`,
    },
    400,
  );
}

function duplicateName(context: FinanceContext) {
  return context.json({ error: "A category with that name exists." }, 409);
}

function categoryNotFound(context: FinanceContext) {
  return context.json({ error: "Category not found." }, 404);
}
