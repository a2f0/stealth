import { and, asc, count, eq, sql } from "drizzle-orm";
import { excluded, getDb } from "./db";
import type { FinanceContext } from "./financeContext";
import {
  financeExpenseCategories,
  financeTransactionAnnotations,
  plaidTransactions,
} from "./schema";

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
  const rows = await getDb(database)
    .select({
      id: financeExpenseCategories.id,
      name: financeExpenseCategories.name,
      transaction_count: count(plaidTransactions.id),
    })
    .from(financeExpenseCategories)
    .leftJoin(
      financeTransactionAnnotations,
      eq(
        financeTransactionAnnotations.expenseCategoryId,
        financeExpenseCategories.id,
      ),
    )
    .leftJoin(
      plaidTransactions,
      and(
        eq(plaidTransactions.id, financeTransactionAnnotations.transactionId),
        eq(plaidTransactions.sourceStatus, "active"),
      ),
    )
    .where(eq(financeExpenseCategories.organizationId, organizationId))
    .groupBy(financeExpenseCategories.id)
    .orderBy(asc(sql`${financeExpenseCategories.name} collate nocase`));
  return rows.map(toCategory);
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
  await getDb(context.env.DB)
    .insert(financeExpenseCategories)
    .values({ id, organizationId, name, createdAt: now, updatedAt: now });
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
  await getDb(context.env.DB)
    .update(financeExpenseCategories)
    .set({ name, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(financeExpenseCategories.id, id),
        eq(financeExpenseCategories.organizationId, organizationId),
      ),
    );
  return context.json({ category: { id, name } });
}

export async function deleteCategory(context: FinanceContext) {
  const id = context.req.param("id");
  const organizationId = context.get("organizationId");
  if (!id || !(await findCategory(context.env.DB, organizationId, id))) {
    return categoryNotFound(context);
  }
  const db = getDb(context.env.DB);
  // Unassign explicitly rather than relying on the foreign-key action alone.
  await db.batch([
    db
      .update(financeTransactionAnnotations)
      .set({ expenseCategoryId: null })
      .where(
        and(
          eq(financeTransactionAnnotations.organizationId, organizationId),
          eq(financeTransactionAnnotations.expenseCategoryId, id),
        ),
      ),
    db
      .delete(financeExpenseCategories)
      .where(
        and(
          eq(financeExpenseCategories.id, id),
          eq(financeExpenseCategories.organizationId, organizationId),
        ),
      ),
  ]);
  return context.body(null, 204);
}

export async function addDefaultCategories(context: FinanceContext) {
  const organizationId = context.get("organizationId");
  const now = new Date().toISOString();
  const db = getDb(context.env.DB);
  const insertCategory = (name: string) =>
    db
      .insert(financeExpenseCategories)
      .values({
        id: crypto.randomUUID(),
        organizationId,
        name,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  const [firstName, ...otherNames] = defaultExpenseCategories;
  await db.batch([
    insertCategory(firstName),
    ...otherNames.map(insertCategory),
  ]);
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
  const db = getDb(database);
  const transaction = await db
    .select({ id: plaidTransactions.id })
    .from(plaidTransactions)
    .where(
      and(
        eq(plaidTransactions.id, transactionId),
        eq(plaidTransactions.organizationId, organizationId),
      ),
    )
    .get();
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
  await db
    .insert(financeTransactionAnnotations)
    .values({
      transactionId,
      organizationId,
      note: "",
      labels: "[]",
      reviewed: 0,
      expenseCategoryId: categoryId,
      createdBy: userId,
      updatedBy: userId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: financeTransactionAnnotations.transactionId,
      set: {
        expenseCategoryId: excluded(
          financeTransactionAnnotations.expenseCategoryId,
        ),
        updatedBy: excluded(financeTransactionAnnotations.updatedBy),
        updatedAt: excluded(financeTransactionAnnotations.updatedAt),
      },
    });
  return context.json({ expenseCategoryId: categoryId });
}

async function findCategory(
  database: D1Database,
  organizationId: string,
  id: string,
) {
  return getDb(database)
    .select({ id: financeExpenseCategories.id })
    .from(financeExpenseCategories)
    .where(
      and(
        eq(financeExpenseCategories.id, id),
        eq(financeExpenseCategories.organizationId, organizationId),
      ),
    )
    .get();
}

async function nameTaken(
  database: D1Database,
  organizationId: string,
  name: string,
  exceptId?: string,
) {
  const existing = await getDb(database)
    .select({ id: financeExpenseCategories.id })
    .from(financeExpenseCategories)
    .where(
      and(
        eq(financeExpenseCategories.organizationId, organizationId),
        sql`${financeExpenseCategories.name} = ${name} collate nocase`,
      ),
    )
    .get();
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

/** The value an upsert tried to insert into `column`. */

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
