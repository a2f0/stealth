import { Database, type SQLQueryBindings } from "bun:sqlite";
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
import type { Bindings } from "./types";

const encryptionKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

describe("finance", () => {
  it("links and imports transactions without exposing the access token", async () => {
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
      "access-sandbox-test",
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
        categoryPrimary: "FOOD_AND_DRINK",
        merchantName: "Test Cafe",
      },
    ]);

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

    const disconnected = await fixture.app.request(
      `/connections/${exchange.body.connectionId}`,
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
    expect(afterDisconnect.body.connections).toEqual([]);
    expect(afterDisconnect.body.transactions).toEqual([]);
  });
});

interface FinanceListing {
  accounts: object[];
  configured: boolean;
  connections: object[];
  transactions: object[];
}

async function createFixture() {
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
  const requestPlaid = mockPlaid();
  const bindings = bindingsFor(database);
  return {
    app: testApp("org_user-1", requestPlaid),
    bindings,
    database,
    requestPlaid,
  };
}

function mockPlaid(): PlaidRequest {
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
      return {
        access_token: "access-sandbox-test",
        item_id: "item-sandbox-test",
      } as T;
    }
    if (path === "/transactions/sync") {
      expect(body.access_token).toBe("access-sandbox-test");
      return transactionPage() as T;
    }
    if (path === "/item/remove") {
      expect(body.access_token).toBe("access-sandbox-test");
      return { request_id: "remove-test" } as T;
    }
    throw new Error(`Unexpected Plaid path: ${path}`);
  };
}

function transactionPage(): TransactionsSyncResponse {
  return {
    accounts: [
      {
        account_id: "account-test",
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
        account_id: "account-test",
        amount: 42.75,
        authorized_date: "2026-08-18",
        date: "2026-08-19",
        iso_currency_code: "USD",
        merchant_name: "Test Cafe",
        name: "Test Cafe Purchase",
        payment_channel: "in store",
        pending: false,
        personal_finance_category: {
          detailed: "FOOD_AND_DRINK_RESTAURANT",
          primary: "FOOD_AND_DRINK",
        },
        transaction_id: "transaction-test",
        unofficial_currency_code: null,
      },
    ],
    has_more: false,
    modified: [],
    next_cursor: "cursor-test",
    removed: [],
  };
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
  app.route("/", createFinanceRouter(requestPlaid));
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
  const response = await app.request(path, init, bindings);
  return { body: (await response.json()) as T, response };
}

function bindingsFor(database: Database): Bindings {
  return {
    AUTH_EMAIL_FROM: "security@auth.tearleads.com",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    BETTER_AUTH_URL: "https://api.test",
    CORS_ORIGIN: "https://app.test",
    DB: toD1(database),
    EMAIL: {} as SendEmail,
    INBOUND_EMAIL_ADDRESS: "upload@inbox.tearleads.com",
    PLAID_CLIENT_ID: "client-test",
    PLAID_ENV: "sandbox",
    PLAID_REDIRECT_URI: "https://app.test/finance",
    PLAID_SECRET: "secret-test",
    PLAID_TOKEN_ENCRYPTION_KEY: encryptionKey,
    STORAGE: {} as R2Bucket,
  };
}

interface TestStatement {
  execute: () => unknown;
}

function toD1(database: Database) {
  return {
    batch: async (statements: TestStatement[]) =>
      statements.map((statement) => statement.execute()),
    prepare: (query: string) => {
      let values: SQLQueryBindings[] = [];
      const statement = {
        all: async () => ({
          results: database.query(query).all(...values),
          success: true,
        }),
        bind: (...nextValues: SQLQueryBindings[]) => {
          values = nextValues;
          return statement;
        },
        execute: () => database.query(query).run(...values),
        first: async () => database.query(query).get(...values),
        run: async () => {
          const result = database.query(query).run(...values);
          return { meta: { changes: result.changes }, success: true };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

async function applyMigration(database: Database, filename: string) {
  database.exec(
    await Bun.file(
      new URL(`../migrations/${filename}`, import.meta.url),
    ).text(),
  );
}
