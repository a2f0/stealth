import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { AuthSession } from "./auth";
import type { AuthVariables } from "./authMiddleware";
import { createFinanceRouter } from "./finance";
import type {
  PlaidRequest,
  PlaidRequestBody,
  TransactionsSyncResponse,
} from "./plaid";
import { createTestD1 } from "./testDatabase";
import type { Bindings } from "./types";

const encryptionKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

describe("finance", () => {
  it("retains and reconciles imported history after a disconnect", async () => {
    const fixture = await createFixture();
    const linkToken = await jsonRequest(
      fixture.app,
      fixture.bindings,
      "/link-token",
      "POST",
    );
    expect(linkToken.response.status).toBe(200);
    expect(linkToken.body).toEqual({
      expiration: "2026-08-19T12:30:00Z",
      linkToken: "link-sandbox-test",
    });

    const exchange = await jsonRequest<{ connectionId: string }>(
      fixture.app,
      fixture.bindings,
      "/exchange",
      "POST",
      {
        institutionId: "ins_test",
        institutionName: "First Test Bank",
        publicToken: "public-sandbox-test",
      },
    );
    expect(exchange.response.status).toBe(201);
    const storedToken = fixture.database
      .query(
        `SELECT access_token_ciphertext, organization_id
         FROM plaid_items WHERE id = ?`,
      )
      .get(exchange.body.connectionId) as {
      access_token_ciphertext: string;
      organization_id: string;
    };
    expect(storedToken.organization_id).toBe("org_user-1");
    expect(storedToken.access_token_ciphertext).not.toContain(
      "access-sandbox-test-1",
    );

    const sync = await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/connections/${exchange.body.connectionId}/sync`,
      "POST",
    );
    expect(sync.response.status).toBe(200);
    expect(sync.body).toEqual({ added: 1, modified: 0, removed: 0 });

    const listing = await jsonRequest<FinanceListing>(
      fixture.app,
      fixture.bindings,
      "/",
      "GET",
    );
    expect(listing.body.configured).toBe(true);
    expect(listing.body.connections).toMatchObject([
      {
        accountCount: 1,
        institutionName: "First Test Bank",
        status: "active",
      },
    ]);
    expect(listing.body.accounts).toMatchObject([
      { currentBalance: 1250.5, mask: "1234", name: "Checking" },
    ]);
    expect(listing.body.transactions).toMatchObject([
      {
        accountName: "Checking",
        amount: 42.75,
        annotation: {
          labels: [],
          note: "",
          reviewed: false,
        },
        categoryPrimary: "FOOD_AND_DRINK",
        expenseCategoryId: null,
        merchantName: "Test Cafe",
      },
    ]);
    const accountId = listing.body.accounts[0]?.id;
    const transactionId = listing.body.transactions[0]?.id;
    expect(accountId).toBeString();
    expect(transactionId).toBeString();

    const annotated = await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/transactions/${transactionId}/annotation`,
      "PATCH",
      {
        labels: ["reimbursable", "client"],
        note: "Dinner after the site visit.",
        reviewed: true,
      },
    );
    expect(annotated.response.status).toBe(200);
    const category = await jsonRequest<{ category: { id: string } }>(
      fixture.app,
      fixture.bindings,
      "/categories",
      "POST",
      { name: "Client meals" },
    );
    expect(category.response.status).toBe(201);
    const categoryId = category.body.category.id;
    const assigned = await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/transactions/${transactionId}/category`,
      "PUT",
      { categoryId },
    );
    expect(assigned.response.status).toBe(200);

    const otherOrganization = testApp("organization-2", fixture.requestPlaid);
    const hidden = await jsonRequest<FinanceListing>(
      otherOrganization,
      fixture.bindings,
      "/",
      "GET",
    );
    expect(hidden.body.connections).toEqual([]);
    expect(hidden.body.transactions).toEqual([]);
    const cannotSync = await jsonRequest(
      otherOrganization,
      fixture.bindings,
      `/connections/${exchange.body.connectionId}/sync`,
      "POST",
    );
    expect(cannotSync.response.status).toBe(404);
    const cannotAnnotate = await jsonRequest(
      otherOrganization,
      fixture.bindings,
      `/transactions/${transactionId}/annotation`,
      "PATCH",
      {
        labels: [],
        note: "Not mine",
        reviewed: false,
      },
    );
    expect(cannotAnnotate.response.status).toBe(404);

    const cannotDeleteActive = await fixture.app.request(
      financePath(`/connections/${exchange.body.connectionId}/data`),
      { method: "DELETE" },
      fixture.bindings,
    );
    expect(cannotDeleteActive.status).toBe(409);

    const disconnected = await fixture.app.request(
      financePath(`/connections/${exchange.body.connectionId}`),
      { method: "DELETE" },
      fixture.bindings,
    );
    expect(disconnected.status).toBe(204);
    const afterDisconnect = await jsonRequest<FinanceListing>(
      fixture.app,
      fixture.bindings,
      "/",
      "GET",
    );
    expect(afterDisconnect.body.connections).toMatchObject([
      { accountCount: 1, status: "disconnected" },
    ]);
    expect(afterDisconnect.body.accounts[0]?.id).toBe(accountId);
    expect(afterDisconnect.body.transactions[0]).toMatchObject({
      annotation: {
        labels: ["reimbursable", "client"],
        note: "Dinner after the site visit.",
        reviewed: true,
      },
      expenseCategoryId: categoryId,
      id: transactionId,
    });
    const revoked = fixture.database
      .query(
        `SELECT access_token_ciphertext, access_token_iv, status
         FROM plaid_items WHERE id = ?`,
      )
      .get(exchange.body.connectionId) as {
      access_token_ciphertext: string;
      access_token_iv: string;
      status: string;
    };
    expect(revoked).toEqual({
      access_token_ciphertext: "",
      access_token_iv: "",
      status: "disconnected",
    });

    const reconnected = await jsonRequest<{ connectionId: string }>(
      fixture.app,
      fixture.bindings,
      "/exchange",
      "POST",
      {
        institutionId: "ins_test",
        institutionName: "First Test Bank",
        publicToken: "public-sandbox-test",
      },
    );
    expect(reconnected.response.status).toBe(201);
    await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/connections/${reconnected.body.connectionId}/sync`,
      "POST",
    );
    const afterReconnect = await jsonRequest<FinanceListing>(
      fixture.app,
      fixture.bindings,
      "/",
      "GET",
    );
    expect(afterReconnect.body.connections).toHaveLength(2);
    expect(afterReconnect.body.accounts).toHaveLength(1);
    expect(afterReconnect.body.accounts[0]?.id).toBe(accountId);
    expect(afterReconnect.body.transactions).toHaveLength(1);
    expect(afterReconnect.body.transactions[0]).toMatchObject({
      annotation: {
        labels: ["reimbursable", "client"],
        note: "Dinner after the site visit.",
        reviewed: true,
      },
      expenseCategoryId: categoryId,
      id: transactionId,
    });

    const deleteArchive = await fixture.app.request(
      financePath(`/connections/${exchange.body.connectionId}/data`),
      { method: "DELETE" },
      fixture.bindings,
    );
    expect(deleteArchive.status).toBe(204);
    const disconnectCurrent = await fixture.app.request(
      financePath(`/connections/${reconnected.body.connectionId}`),
      { method: "DELETE" },
      fixture.bindings,
    );
    expect(disconnectCurrent.status).toBe(204);
    const deleteCurrent = await fixture.app.request(
      financePath(`/connections/${reconnected.body.connectionId}/data`),
      { method: "DELETE" },
      fixture.bindings,
    );
    expect(deleteCurrent.status).toBe(204);
    const afterDelete = await jsonRequest<FinanceListing>(
      fixture.app,
      fixture.bindings,
      "/",
      "GET",
    );
    expect(afterDelete.body.connections).toEqual([]);
    expect(afterDelete.body.accounts).toEqual([]);
    expect(afterDelete.body.transactions).toEqual([]);
  });

  it("preserves an annotation when a pending transaction posts", async () => {
    const fixture = await createFixture({ pendingTransition: true });
    const exchange = await jsonRequest<{ connectionId: string }>(
      fixture.app,
      fixture.bindings,
      "/exchange",
      "POST",
      {
        institutionId: "ins_test",
        institutionName: "First Test Bank",
        publicToken: "public-sandbox-test",
      },
    );
    await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/connections/${exchange.body.connectionId}/sync`,
      "POST",
    );
    const pending = await jsonRequest<FinanceListing>(
      fixture.app,
      fixture.bindings,
      "/",
      "GET",
    );
    const transactionId = pending.body.transactions[0]?.id;
    expect(pending.body.transactions[0]?.pending).toBe(true);
    await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/transactions/${transactionId}/annotation`,
      "PATCH",
      {
        labels: ["watch"],
        note: "Waiting for this charge to settle.",
        reviewed: false,
      },
    );

    const sync = await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/connections/${exchange.body.connectionId}/sync`,
      "POST",
    );
    expect(sync.body).toEqual({ added: 1, modified: 0, removed: 1 });
    const posted = await jsonRequest<FinanceListing>(
      fixture.app,
      fixture.bindings,
      "/",
      "GET",
    );
    expect(posted.body.transactions).toHaveLength(1);
    expect(posted.body.transactions[0]).toMatchObject({
      annotation: {
        labels: ["watch"],
        note: "Waiting for this charge to settle.",
      },
      id: transactionId,
      pending: false,
    });
  });
});

describe("expense categories", () => {
  it("manages organization categories with case-insensitive unique names", async () => {
    const fixture = await createFixture();
    const created = await jsonRequest<{ category: Category }>(
      fixture.app,
      fixture.bindings,
      "/categories",
      "POST",
      { name: "  Meals   and  drinks " },
    );
    expect(created.response.status).toBe(201);
    expect(created.body.category).toMatchObject({
      name: "Meals and drinks",
      transactionCount: 0,
    });
    const categoryId = created.body.category.id;

    const duplicate = await jsonRequest(
      fixture.app,
      fixture.bindings,
      "/categories",
      "POST",
      { name: "meals AND drinks" },
    );
    expect(duplicate.response.status).toBe(409);
    for (const name of ["", "   ", "x".repeat(61), 42]) {
      const invalid = await jsonRequest(
        fixture.app,
        fixture.bindings,
        "/categories",
        "POST",
        { name },
      );
      expect(invalid.response.status).toBe(400);
    }

    const renamed = await jsonRequest<{ category: Category }>(
      fixture.app,
      fixture.bindings,
      `/categories/${categoryId}`,
      "PATCH",
      { name: "Client meals" },
    );
    expect(renamed.response.status).toBe(200);
    const sameNameOtherCase = await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/categories/${categoryId}`,
      "PATCH",
      { name: "client MEALS" },
    );
    expect(sameNameOtherCase.response.status).toBe(200);

    const defaults = await jsonRequest<{ categories: Category[] }>(
      fixture.app,
      fixture.bindings,
      "/categories/defaults",
      "POST",
    );
    expect(defaults.response.status).toBe(200);
    expect(defaults.body.categories).toHaveLength(15);
    const again = await jsonRequest<{ categories: Category[] }>(
      fixture.app,
      fixture.bindings,
      "/categories/defaults",
      "POST",
    );
    expect(again.body.categories).toHaveLength(15);
    const travel = again.body.categories.find(({ name }) => name === "Travel");
    expect(travel).toBeDefined();
    const clash = await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/categories/${categoryId}`,
      "PATCH",
      { name: "travel" },
    );
    expect(clash.response.status).toBe(409);

    const otherOrganization = testApp("organization-2", fixture.requestPlaid);
    const hidden = await jsonRequest<{ categories: Category[] }>(
      otherOrganization,
      fixture.bindings,
      "/categories",
      "GET",
    );
    expect(hidden.body.categories).toEqual([]);
    const cannotRename = await jsonRequest(
      otherOrganization,
      fixture.bindings,
      `/categories/${categoryId}`,
      "PATCH",
      { name: "Taken over" },
    );
    expect(cannotRename.response.status).toBe(404);
    const cannotDelete = await otherOrganization.request(
      financePath(`/categories/${categoryId}`),
      { method: "DELETE" },
      fixture.bindings,
    );
    expect(cannotDelete.status).toBe(404);
  });

  it("assigns at most one category per transaction and unassigns on delete", async () => {
    const fixture = await createFixture();
    const [transactionId] = seedTransactions(fixture.database);
    if (!transactionId) throw new Error("Missing seeded transaction.");
    const meals = await createCategory(fixture, "Meals");
    const travel = await createCategory(fixture, "Travel");

    for (const categoryId of [meals, travel]) {
      const assigned = await jsonRequest<{ expenseCategoryId: string }>(
        fixture.app,
        fixture.bindings,
        `/transactions/${transactionId}/category`,
        "PUT",
        { categoryId },
      );
      expect(assigned.response.status).toBe(200);
      expect(assigned.body.expenseCategoryId).toBe(categoryId);
    }
    const listing = await jsonRequest<FinanceListing>(
      fixture.app,
      fixture.bindings,
      "/",
      "GET",
    );
    const transaction = listing.body.transactions.find(
      ({ id }) => id === transactionId,
    );
    expect(transaction?.expenseCategoryId).toBe(travel);
    expect(listing.body.categories).toMatchObject([
      { name: "Meals", transactionCount: 0 },
      { name: "Travel", transactionCount: 1 },
    ]);
    const annotations = fixture.database
      .query(
        "SELECT COUNT(*) AS count FROM finance_transaction_annotations WHERE transaction_id = ?",
      )
      .get(transactionId) as { count: number };
    expect(annotations.count).toBe(1);

    for (const body of [{}, { categoryId: 7 }, { categoryId: "" }, null]) {
      const invalid = await jsonRequest(
        fixture.app,
        fixture.bindings,
        `/transactions/${transactionId}/category`,
        "PUT",
        body,
      );
      expect(invalid.response.status).toBe(400);
    }
    const unknownCategory = await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/transactions/${transactionId}/category`,
      "PUT",
      { categoryId: "missing" },
    );
    expect(unknownCategory.response.status).toBe(404);
    const otherOrganization = testApp("organization-2", fixture.requestPlaid);
    const foreignTransaction = await jsonRequest(
      otherOrganization,
      fixture.bindings,
      `/transactions/${transactionId}/category`,
      "PUT",
      { categoryId: null },
    );
    expect(foreignTransaction.response.status).toBe(404);

    const deleted = await fixture.app.request(
      financePath(`/categories/${travel}`),
      { method: "DELETE" },
      fixture.bindings,
    );
    expect(deleted.status).toBe(204);
    const afterDelete = await jsonRequest<FinanceListing>(
      fixture.app,
      fixture.bindings,
      "/",
      "GET",
    );
    expect(
      afterDelete.body.transactions.find(({ id }) => id === transactionId)
        ?.expenseCategoryId,
    ).toBeNull();
    expect(afterDelete.body.categories.map(({ name }) => name)).toEqual([
      "Meals",
    ]);

    const cleared = await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/transactions/${transactionId}/category`,
      "PUT",
      { categoryId: null },
    );
    expect(cleared.response.status).toBe(200);
  });

  it("reports expense totals by category with transfers and income excluded", async () => {
    const fixture = await createFixture();
    const ids = seedTransactions(fixture.database);
    const meals = await createCategory(fixture, "Meals");
    const software = await createCategory(fixture, "Software");
    await createCategory(fixture, "Travel");
    const assignments: [number, string][] = [
      [0, meals],
      [1, meals],
      [2, meals],
      [9, meals],
      [11, software],
    ];
    for (const [index, categoryId] of assignments) {
      const assigned = await jsonRequest(
        fixture.app,
        fixture.bindings,
        `/transactions/${ids[index]}/category`,
        "PUT",
        { categoryId },
      );
      expect(assigned.response.status).toBe(200);
    }

    const august = await jsonRequest<ExpenseReport>(
      fixture.app,
      fixture.bindings,
      "/reports/expenses?from=2026-08-01&to=2026-08-31",
      "GET",
    );
    expect(august.response.status).toBe(200);
    expect(august.body.from).toBe("2026-08-01");
    expect(august.body.to).toBe("2026-08-31");
    expect(august.body.currencies.map(({ currency }) => currency)).toEqual([
      "EUR",
      "USD",
    ]);
    const usd = august.body.currencies.find(
      ({ currency }) => currency === "USD",
    );
    expect(usd).toEqual({
      categories: [
        { id: null, name: "Uncategorized", total: 300, transactionCount: 1 },
        { id: meals, name: "Meals", total: 130.25, transactionCount: 3 },
        { id: software, name: "Software", total: 25, transactionCount: 1 },
        {
          id: expect.any(String),
          name: "Travel",
          total: 0,
          transactionCount: 0,
        },
      ],
      currency: "USD",
      excludedTransfers: { total: 575, transactionCount: 2 },
      total: 455.25,
      transactionCount: 5,
    });
    const eur = august.body.currencies.find(
      ({ currency }) => currency === "EUR",
    );
    expect(eur?.total).toBe(45);
    expect(eur?.categories[0]).toEqual({
      id: null,
      name: "Uncategorized",
      total: 45,
      transactionCount: 1,
    });

    const allTime = await jsonRequest<ExpenseReport>(
      fixture.app,
      fixture.bindings,
      "/reports/expenses",
      "GET",
    );
    const allTimeUsd = allTime.body.currencies.find(
      ({ currency }) => currency === "USD",
    );
    expect(allTime.body.from).toBeNull();
    expect(allTimeUsd?.total).toBe(535.25);
    expect(
      allTimeUsd?.categories.find(({ name }) => name === "Meals"),
    ).toMatchObject({ total: 210.25, transactionCount: 4 });

    for (const query of [
      "?from=2026-13-01",
      "?to=2026-02-30",
      "?from=2026-08-31&to=2026-08-01",
      "?from=yesterday",
    ]) {
      const invalid = await jsonRequest(
        fixture.app,
        fixture.bindings,
        `/reports/expenses${query}`,
        "GET",
      );
      expect(invalid.response.status).toBe(400);
    }
    const otherOrganization = testApp("organization-2", fixture.requestPlaid);
    const hidden = await jsonRequest<ExpenseReport>(
      otherOrganization,
      fixture.bindings,
      "/reports/expenses",
      "GET",
    );
    expect(hidden.body.currencies).toEqual([]);
  });

  it("migrates free-text category overrides into categories", async () => {
    const database = new Database(":memory:");
    for (const migration of [
      "0003_create_auth.sql",
      "0004_create_organizations.sql",
      "0007_create_finance.sql",
      "0009_retain_finance_history.sql",
    ]) {
      await applyMigration(database, migration);
    }
    const overrides: [string, string, string | null][] = [
      ["txn-a", "org-a", "Client meal"],
      ["txn-b", "org-a", " client MEAL "],
      ["txn-c", "org-a", "Travel"],
      ["txn-d", "org-b", "Travel"],
      ["txn-e", "org-b", "   "],
      ["txn-f", "org-b", null],
    ];
    for (const [transactionId, organizationId, override] of overrides) {
      database
        .query(
          `INSERT INTO finance_transaction_annotations
             (transaction_id, organization_id, category_override, created_by,
              updated_by, created_at, updated_at)
           VALUES (?, ?, ?, 'user-1', 'user-1', ?, ?)`,
        )
        .run(
          transactionId,
          organizationId,
          override,
          "2026-08-19T12:00:00.000Z",
          "2026-08-19T12:00:00.000Z",
        );
    }
    await applyMigration(
      database,
      "0034_create_finance_expense_categories.sql",
    );

    const categories = database
      .query(
        `SELECT organization_id, name FROM finance_expense_categories
         ORDER BY organization_id, name`,
      )
      .all();
    expect(categories).toEqual([
      { name: "Client meal", organization_id: "org-a" },
      { name: "Travel", organization_id: "org-a" },
      { name: "Travel", organization_id: "org-b" },
    ]);
    const assigned = database
      .query(
        `SELECT annotation.transaction_id, category.name, category.organization_id
         FROM finance_transaction_annotations AS annotation
         LEFT JOIN finance_expense_categories AS category
           ON category.id = annotation.expense_category_id
         ORDER BY annotation.transaction_id`,
      )
      .all();
    expect(assigned).toEqual([
      {
        name: "Client meal",
        organization_id: "org-a",
        transaction_id: "txn-a",
      },
      {
        name: "Client meal",
        organization_id: "org-a",
        transaction_id: "txn-b",
      },
      { name: "Travel", organization_id: "org-a", transaction_id: "txn-c" },
      { name: "Travel", organization_id: "org-b", transaction_id: "txn-d" },
      { name: null, organization_id: null, transaction_id: "txn-e" },
      { name: null, organization_id: null, transaction_id: "txn-f" },
    ]);
  });
});

interface Category {
  id: string;
  name: string;
  transactionCount: number;
}

interface ExpenseReport {
  currencies: {
    categories: {
      id: string | null;
      name: string;
      total: number;
      transactionCount: number;
    }[];
    currency: string;
    excludedTransfers: { total: number; transactionCount: number };
    total: number;
    transactionCount: number;
  }[];
  from: string | null;
  to: string | null;
}

async function createCategory(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  name: string,
) {
  const created = await jsonRequest<{ category: Category }>(
    fixture.app,
    fixture.bindings,
    "/categories",
    "POST",
    { name },
  );
  expect(created.response.status).toBe(201);
  return created.body.category.id;
}

/**
 * Twelve transactions for org_user-1 that exercise every reporting rule.
 * Positive amounts are money leaving the account, as Plaid reports them.
 */
function seedTransactions(database: Database) {
  const now = "2026-08-31T12:00:00.000Z";
  database
    .query(
      `INSERT INTO plaid_items
         (id, organization_id, plaid_item_id, access_token_ciphertext,
          access_token_iv, status, created_by, created_at, updated_at)
       VALUES ('item-report', 'org_user-1', 'plaid-item-report', '', '',
               'active', 'user-1', ?, ?)`,
    )
    .run(now, now);
  database
    .query(
      `INSERT INTO plaid_accounts
         (id, plaid_account_id, organization_id, plaid_item_record_id, name,
          type, updated_at)
       VALUES ('account-report', 'plaid-account-report', 'org_user-1',
               'item-report', 'Operating', 'depository', ?)`,
    )
    .run(now);
  const rows: [number, string, string | null, number, string, string][] = [
    [100, "2026-08-05", "FOOD_AND_DRINK", 0, "active", "USD"],
    [50.25, "2026-08-10", "FOOD_AND_DRINK", 0, "active", "USD"],
    [-20, "2026-08-12", "FOOD_AND_DRINK", 0, "active", "USD"],
    [300, "2026-08-14", "GENERAL_SERVICES", 0, "active", "USD"],
    [500, "2026-08-15", "TRANSFER_OUT", 0, "active", "USD"],
    [75, "2026-08-16", "LOAN_PAYMENTS", 0, "active", "USD"],
    [-1000, "2026-08-17", "INCOME", 0, "active", "USD"],
    [40, "2026-08-18", "FOOD_AND_DRINK", 1, "active", "USD"],
    [60, "2026-08-19", "GENERAL_MERCHANDISE", 0, "removed", "USD"],
    [80, "2026-07-20", "FOOD_AND_DRINK", 0, "active", "USD"],
    [45, "2026-08-21", "TRAVEL", 0, "active", "EUR"],
    [25, "2026-08-22", "TRANSFER_OUT", 0, "active", "USD"],
  ];
  return rows.map(
    ([amount, date, category, pending, status, currency], index) => {
      const id = `report-txn-${index}`;
      database
        .query(
          `INSERT INTO plaid_transactions
           (id, plaid_transaction_id, organization_id, plaid_item_record_id,
            account_record_id, name, amount, currency_code, transaction_date,
            category_primary, pending, source_status, updated_at)
         VALUES (?, ?, 'org_user-1', 'item-report', 'account-report', ?, ?, ?,
                 ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          `plaid-${id}`,
          `Transaction ${index}`,
          amount,
          currency,
          date,
          category,
          pending,
          status,
          now,
        );
      return id;
    },
  );
}

interface FinanceListing {
  accounts: { id: string }[];
  categories: Category[];
  configured: boolean;
  connections: { accountCount: number; status: string }[];
  transactions: {
    annotation: {
      labels: string[];
      note: string;
      reviewed: boolean;
    };
    expenseCategoryId: string | null;
    id: string;
    pending: boolean;
  }[];
}

async function createFixture(options?: { pendingTransition?: boolean }) {
  const database = new Database(":memory:");
  await applyMigration(database, "0003_create_auth.sql");
  database
    .query(
      `INSERT INTO user
       (id, name, email, emailVerified, createdAt, updatedAt, role, banned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "user-1",
      "Example Person",
      "person@example.com",
      false,
      "2026-08-19T12:00:00.000Z",
      "2026-08-19T12:00:00.000Z",
      "user",
      false,
    );
  await applyMigration(database, "0004_create_organizations.sql");
  await applyMigration(database, "0007_create_finance.sql");
  await applyMigration(database, "0009_retain_finance_history.sql");
  await applyMigration(database, "0034_create_finance_expense_categories.sql");
  for (const migration of [
    "0001_create_objects.sql",
    "0006_scope_objects_to_organizations.sql",
    "0025_classify_objects.sql",
    "0002_create_inbound_emails.sql",
    // 0011's organization triggers reference 0010's groups; newer SQLite
    // rejects 0012's table rename while any trigger names a missing table.
    "0010_create_organization_groups.sql",
    "0011_soft_delete_organizations.sql",
    "0012_scope_inbound_emails_to_organizations.sql",
    "0016_soft_delete_inbound_emails.sql",
    "0035_create_library_folders.sql",
    "0036_create_inbound_email_links.sql",
  ]) {
    await applyMigration(database, migration);
  }
  const requestPlaid = mockPlaid(options);
  const bindings = bindingsFor(database);
  return {
    app: testApp("org_user-1", requestPlaid),
    bindings,
    database,
    requestPlaid,
  };
}

function mockPlaid(options?: { pendingTransition?: boolean }): PlaidRequest {
  let exchangeCount = 0;
  let syncCount = 0;
  return async <T>(_env: Bindings, path: string, body: PlaidRequestBody) => {
    if (path === "/link/token/create") {
      expect(body.transactions).toEqual({ days_requested: 730 });
      return {
        expiration: "2026-08-19T12:30:00Z",
        link_token: "link-sandbox-test",
      } as T;
    }
    if (path === "/item/public_token/exchange") {
      expect(body.public_token).toBe("public-sandbox-test");
      exchangeCount += 1;
      return {
        access_token: `access-sandbox-test-${exchangeCount}`,
        item_id: `item-sandbox-test-${exchangeCount}`,
      } as T;
    }
    if (path === "/transactions/sync") {
      expect(body.access_token).toStartWith("access-sandbox-test-");
      syncCount += 1;
      if (options?.pendingTransition) {
        return (syncCount === 1 ? pendingPage() : postedPage()) as T;
      }
      const connectionNumber = String(body.access_token).split("-").at(-1);
      return transactionPage(connectionNumber) as T;
    }
    if (path === "/item/remove") {
      expect(body.access_token).toStartWith("access-sandbox-test-");
      return { request_id: "remove-test" } as T;
    }
    throw new Error(`Unexpected Plaid path: ${path}`);
  };
}

function transactionPage(connectionNumber = "1"): TransactionsSyncResponse {
  return {
    accounts: [
      {
        account_id: `account-test-${connectionNumber}`,
        balances: {
          available: 1200,
          current: 1250.5,
          iso_currency_code: "USD",
          unofficial_currency_code: null,
        },
        mask: "1234",
        name: "Checking",
        official_name: "Plaid Gold Checking",
        subtype: "checking",
        type: "depository",
      },
    ],
    added: [
      {
        account_id: `account-test-${connectionNumber}`,
        amount: 42.75,
        authorized_date: "2026-08-18",
        date: "2026-08-19",
        iso_currency_code: "USD",
        merchant_name: "Test Cafe",
        name: "Test Cafe Purchase",
        payment_channel: "in store",
        pending: false,
        pending_transaction_id: null,
        personal_finance_category: {
          detailed: "FOOD_AND_DRINK_RESTAURANT",
          primary: "FOOD_AND_DRINK",
        },
        transaction_id: `transaction-test-${connectionNumber}`,
        unofficial_currency_code: null,
      },
    ],
    has_more: false,
    modified: [],
    next_cursor: "cursor-test",
    removed: [],
  };
}

function pendingPage(): TransactionsSyncResponse {
  const page = transactionPage();
  const transaction = page.added[0];
  if (!transaction) throw new Error("Missing transaction fixture.");
  transaction.pending = true;
  transaction.transaction_id = "transaction-pending";
  page.next_cursor = "cursor-pending";
  return page;
}

function postedPage(): TransactionsSyncResponse {
  const page = transactionPage();
  const transaction = page.added[0];
  if (!transaction) throw new Error("Missing transaction fixture.");
  transaction.pending_transaction_id = "transaction-pending";
  transaction.transaction_id = "transaction-posted";
  page.next_cursor = "cursor-posted";
  page.removed = [{ transaction_id: "transaction-pending" }];
  return page;
}

function testApp(organizationId: string, requestPlaid: PlaidRequest) {
  const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
  app.use("*", async (context, next) => {
    context.set("organizationId", organizationId);
    context.set("authSession", {
      user: {
        defaultOrganizationId: organizationId,
        id: "user-1",
        role: "user",
      },
    } as unknown as AuthSession);
    await next();
  });
  app.route("/api/finance", createFinanceRouter(requestPlaid));
  return app;
}

async function jsonRequest<T = unknown>(
  app: ReturnType<typeof testApp>,
  bindings: Bindings,
  path: string,
  method: string,
  body?: unknown,
) {
  const init: RequestInit = {
    headers: { "content-type": "application/json" },
    method,
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await app.request(financePath(path), init, bindings);
  return { body: (await response.json()) as T, response };
}

function financePath(path: string) {
  return path === "/" ? "/api/finance" : `/api/finance${path}`;
}

function bindingsFor(database: Database): Bindings {
  return {
    AUTH_EMAIL_FROM: "security@auth.tearleads.de",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    BETTER_AUTH_URL: "https://api.test",
    CORS_ORIGIN: "https://app.test",
    DB: createTestD1(database),
    EMAIL: {} as SendEmail,
    IMAGES: {} as ImagesBinding,
    INBOUND_EMAIL_DOMAIN: "inbox.tearleads.de",
    PLAID_CLIENT_ID: "client-test",
    PLAID_ENV: "sandbox",
    PLAID_REDIRECT_URI: "https://app.test/finance",
    PLAID_SECRET: "secret-test",
    PLAID_TOKEN_ENCRYPTION_KEY: encryptionKey,
    STORAGE: {} as R2Bucket,
  };
}

async function applyMigration(database: Database, filename: string) {
  database.exec(
    await Bun.file(
      new URL(`../migrations/${filename}`, import.meta.url),
    ).text(),
  );
}
