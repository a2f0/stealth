import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readdir } from "node:fs/promises";
import { Hono } from "hono";
import type { AuthSession } from "./auth";
import type { AuthVariables } from "./authMiddleware";
import { createFinanceRouter } from "./finance";
import { inbox } from "./inbox";
import { libraryFolders } from "./libraryFolders";
import type { Bindings } from "./types";

const timestamp = "2026-09-20T12:00:00.000Z";
const rawEmail = [
  "From: Sender <sender@example.com>",
  "To: upload@inbox.tearleads.de",
  "Subject: Receipt",
  "Content-Type: text/plain",
  "",
  "Thanks for your purchase.",
  "",
].join("\r\n");

interface EmailLink {
  folder?: { name: string };
  id: string;
  targetId: string;
  targetType: string;
  transaction?: { amount: number; name: string };
}

interface LinkedEmail {
  id: string;
  linkId: string;
  subject: string | null;
}

describe("inbound email links", () => {
  it("links an email to a library folder once and unlinks it", async () => {
    const fixture = await createFixture();
    const member = fixture.as("member-user");

    const created = await member.json<{ link: EmailLink }>(
      "POST",
      "/api/inbox/email-1/links",
      { targetId: "folder-1", targetType: "library_folder" },
    );
    expect(created.status).toBe(201);
    expect(created.body.link).toMatchObject({
      folder: { name: "Receipts" },
      targetId: "folder-1",
      targetType: "library_folder",
    });
    const repeated = await member.json<{ link: EmailLink }>(
      "POST",
      "/api/inbox/email-1/links",
      { targetId: "folder-1", targetType: "library_folder" },
    );
    expect(repeated.status).toBe(200);
    expect(repeated.body.link.id).toBe(created.body.link.id);

    expect(await linksFor(member, "email-1")).toEqual([created.body.link]);
    const folder = await member.json<{
      emails: LinkedEmail[];
      folder: { emailCount: number };
    }>("GET", "/api/library/folders/folder-1");
    expect(folder.body.folder.emailCount).toBe(1);
    expect(folder.body.emails).toEqual([
      expect.objectContaining({
        id: "email-1",
        linkId: created.body.link.id,
        subject: "Receipt",
      }),
    ]);

    const removed = await member.json(
      "DELETE",
      `/api/inbox/email-1/links/${created.body.link.id}`,
    );
    expect(removed.status).toBe(204);
    expect(await linksFor(member, "email-1")).toEqual([]);
    expect(
      (
        await member.json(
          "DELETE",
          `/api/inbox/email-1/links/${created.body.link.id}`,
        )
      ).status,
    ).toBe(404);
  });

  it("limits transaction links to Finance group members", async () => {
    const fixture = await createFixture();
    const member = fixture.as("member-user");
    const financeMember = fixture.as("finance-user");
    const target = { targetId: "txn-1", targetType: "finance_transaction" };

    expect(
      (await member.json("POST", "/api/inbox/email-1/links", target)).status,
    ).toBe(403);
    const created = await financeMember.json<{ link: EmailLink }>(
      "POST",
      "/api/inbox/email-1/links",
      target,
    );
    expect(created.status).toBe(201);
    expect(created.body.link.transaction).toMatchObject({
      amount: 42.75,
      name: "Test Cafe Purchase",
    });
    await member.json("POST", "/api/inbox/email-1/links", {
      targetId: "folder-1",
      targetType: "library_folder",
    });

    expect(
      (await linksFor(financeMember, "email-1")).map(
        ({ targetType }) => targetType,
      ),
    ).toEqual(["finance_transaction", "library_folder"]);
    expect(
      (await linksFor(member, "email-1")).map(({ targetType }) => targetType),
    ).toEqual(["library_folder"]);
    expect(
      (
        await member.json(
          "DELETE",
          `/api/inbox/email-1/links/${created.body.link.id}`,
        )
      ).status,
    ).toBe(403);

    const finance = await financeMember.json<{
      transactions: Array<{ id: string; linkedEmails: LinkedEmail[] }>;
    }>("GET", "/api/finance");
    const linked = finance.body.transactions.find(({ id }) => id === "txn-1");
    expect(linked?.linkedEmails).toEqual([
      expect.objectContaining({ id: "email-1", subject: "Receipt" }),
    ]);
    expect(
      finance.body.transactions.find(({ id }) => id === "txn-2")?.linkedEmails,
    ).toEqual([]);
  });

  it("rejects other organizations' records and emails in Trash", async () => {
    const fixture = await createFixture();
    const financeMember = fixture.as("finance-user");

    for (const target of [
      { targetId: "folder-other", targetType: "library_folder" },
      { targetId: "txn-other", targetType: "finance_transaction" },
      { targetId: "txn-removed", targetType: "finance_transaction" },
    ]) {
      expect(
        (await financeMember.json("POST", "/api/inbox/email-1/links", target))
          .status,
      ).toBe(404);
    }
    expect(
      (
        await financeMember.json("POST", "/api/inbox/email-other/links", {
          targetId: "folder-1",
          targetType: "library_folder",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await financeMember.json("POST", "/api/inbox/email-1/links", {
          targetId: "folder-1",
          targetType: "audit",
        })
      ).status,
    ).toBe(400);

    await financeMember.json("POST", "/api/inbox/email-1/links", {
      targetId: "folder-1",
      targetType: "library_folder",
    });
    await financeMember.json("DELETE", "/api/inbox/email-1");
    expect(
      (
        await financeMember.json("POST", "/api/inbox/email-1/links", {
          targetId: "txn-1",
          targetType: "finance_transaction",
        })
      ).status,
    ).toBe(404);
    const folder = await financeMember.json<{
      emails: LinkedEmail[];
      folder: { emailCount: number };
    }>("GET", "/api/library/folders/folder-1");
    expect(folder.body).toMatchObject({
      emails: [],
      folder: { emailCount: 0 },
    });

    await financeMember.json("POST", "/api/inbox/email-1/restore");
    expect(
      (
        await financeMember.json<{ emails: LinkedEmail[] }>(
          "GET",
          "/api/library/folders/folder-1",
        )
      ).body.emails,
    ).toHaveLength(1);
  });

  it("removes links when either side is deleted", async () => {
    const fixture = await createFixture();
    const financeMember = fixture.as("finance-user");
    for (const target of [
      { targetId: "folder-1", targetType: "library_folder" },
      { targetId: "txn-1", targetType: "finance_transaction" },
    ]) {
      await financeMember.json("POST", "/api/inbox/email-1/links", target);
      await financeMember.json("POST", "/api/inbox/email-2/links", target);
    }
    const remaining = () =>
      fixture.database
        .query(
          `SELECT email_id, target_type FROM inbound_email_links
           ORDER BY email_id, target_type`,
        )
        .all();

    fixture.database.query("DELETE FROM plaid_items WHERE id = 'item-1'").run();
    expect(remaining()).toEqual([
      { email_id: "email-1", target_type: "library_folder" },
      { email_id: "email-2", target_type: "library_folder" },
    ]);
    fixture.database
      .query("DELETE FROM inbound_emails WHERE id = 'email-2'")
      .run();
    expect(remaining()).toEqual([
      { email_id: "email-1", target_type: "library_folder" },
    ]);
  });
});

describe("finance transaction search", () => {
  it("matches name, merchant, or amount within the organization", async () => {
    const fixture = await createFixture();
    const financeMember = fixture.as("finance-user");
    const search = async (query: string) => {
      const response = await financeMember.json<{
        transactions: Array<{ accountName: string; id: string }>;
      }>("GET", `/api/finance/transactions?q=${encodeURIComponent(query)}`);
      return response.body.transactions.map(({ id }) => id);
    };

    expect(await search("")).toEqual(["txn-2", "txn-1"]);
    expect(await search("cafe")).toEqual(["txn-1"]);
    expect(await search("Office")).toEqual(["txn-2"]);
    expect(await search("$42.75")).toEqual(["txn-1"]);
    expect(await search("1,200")).toEqual(["txn-2"]);
    expect(await search("%")).toEqual([]);
    expect(await search("Other org")).toEqual([]);
    expect(
      (
        await financeMember.json(
          "GET",
          `/api/finance/transactions?q=${"x".repeat(101)}`,
        )
      ).status,
    ).toBe(400);
  });
});

async function linksFor(client: Client, emailId: string) {
  const detail = await client.json<{ email: { links: EmailLink[] } }>(
    "GET",
    `/api/inbox/${emailId}`,
  );
  expect(detail.status).toBe(200);
  return detail.body.email.links;
}

type Client = ReturnType<Awaited<ReturnType<typeof createFixture>>["as"]>;

async function createFixture() {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  await applyMigrations(database);
  seed(database);
  const raw = new TextEncoder().encode(rawEmail);
  const bindings = {
    AUTH_EMAIL_FROM: "security@auth.tearleads.de",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    BETTER_AUTH_URL: "https://api.test",
    CORS_ORIGIN: "https://app.test",
    DB: toD1(database),
    EMAIL: {} as SendEmail,
    IMAGES: {} as ImagesBinding,
    INBOUND_EMAIL_DOMAIN: "inbox.tearleads.de",
    STORAGE: {
      get: async () => ({ arrayBuffer: async () => raw.slice().buffer }),
    } as unknown as R2Bucket,
  } satisfies Bindings;

  function as(userId: string) {
    const app = testApp(userId);
    return {
      json: async <T = unknown>(
        method: string,
        path: string,
        body?: unknown,
      ) => {
        const init: RequestInit = { method };
        if (body !== undefined) {
          init.body = JSON.stringify(body);
          init.headers = { "content-type": "application/json" };
        }
        const response = await app.request(path, init, bindings);
        const text = await response.text();
        return {
          body: (text ? JSON.parse(text) : null) as T,
          status: response.status,
        };
      },
    };
  }
  return { as, database };
}

function seed(database: Database) {
  const run = (query: string, ...values: SQLQueryBindings[]) =>
    database.query(query).run(...values);
  for (const id of ["finance-user", "member-user", "other-user"]) {
    run(
      `INSERT INTO user
       (id, name, email, emailVerified, createdAt, updatedAt, role, banned)
       VALUES (?, ?, ?, 1, ?, ?, 'user', 0)`,
      id,
      id,
      `${id}@example.com`,
      timestamp,
      timestamp,
    );
  }
  for (const id of ["org-1", "org-2"]) {
    run(
      `INSERT INTO organization (id, name, slug, createdAt)
       VALUES (?, ?, ?, ?)`,
      id,
      id,
      id,
      timestamp,
    );
  }
  run(
    `INSERT INTO team (id, name, organizationId, createdAt)
     VALUES ('team-finance', 'Finance', 'org-1', ?)`,
    timestamp,
  );
  run(
    `INSERT INTO teamMember (id, teamId, userId)
     VALUES ('team-member-1', 'team-finance', 'finance-user')`,
  );
  run(
    `INSERT INTO organization_group_capability
     (organization_id, team_id, capability)
     VALUES ('org-1', 'team-finance', 'finance')`,
  );
  for (const [id, organizationId, name] of [
    ["folder-1", "org-1", "Receipts"],
    ["folder-other", "org-2", "Other"],
  ] as const) {
    run(
      `INSERT INTO library_folders
       (id, organization_id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      id,
      organizationId,
      name,
      timestamp,
      timestamp,
    );
  }
  for (const [id, organizationId] of [
    ["email-1", "org-1"],
    ["email-2", "org-1"],
    ["email-other", "org-2"],
  ] as const) {
    run(
      `INSERT INTO inbound_emails
       (id, organization_id, envelope_from, envelope_to, subject,
        raw_object_key, raw_size, received_at)
       VALUES (?, ?, 'sender@example.com', 'upload@inbox.tearleads.de',
               'Receipt', ?, 1, ?)`,
      id,
      organizationId,
      `raw/${id}`,
      timestamp,
    );
  }
  for (const [item, account, organizationId] of [
    ["item-1", "account-1", "org-1"],
    ["item-other", "account-other", "org-2"],
  ] as const) {
    run(
      `INSERT INTO plaid_items
       (id, organization_id, plaid_item_id, access_token_ciphertext,
        access_token_iv, created_by, created_at, updated_at)
       VALUES (?, ?, ?, '', '', 'finance-user', ?, ?)`,
      item,
      organizationId,
      `plaid-${item}`,
      timestamp,
      timestamp,
    );
    run(
      `INSERT INTO plaid_accounts
       (id, plaid_account_id, organization_id, plaid_item_record_id, name,
        type, updated_at)
       VALUES (?, ?, ?, ?, 'Checking', 'depository', ?)`,
      account,
      `plaid-${account}`,
      organizationId,
      item,
      timestamp,
    );
  }
  for (const [
    id,
    account,
    item,
    organizationId,
    name,
    amount,
    date,
    status,
  ] of [
    [
      "txn-1",
      "account-1",
      "item-1",
      "org-1",
      "Test Cafe Purchase",
      42.75,
      "2026-09-18",
      "active",
    ],
    [
      "txn-2",
      "account-1",
      "item-1",
      "org-1",
      "Office Depot",
      1200,
      "2026-09-19",
      "active",
    ],
    [
      "txn-removed",
      "account-1",
      "item-1",
      "org-1",
      "Removed",
      5,
      "2026-09-17",
      "removed",
    ],
    [
      "txn-other",
      "account-other",
      "item-other",
      "org-2",
      "Other org",
      42.75,
      "2026-09-18",
      "active",
    ],
  ] as const) {
    run(
      `INSERT INTO plaid_transactions
       (id, plaid_transaction_id, organization_id, plaid_item_record_id,
        account_record_id, name, merchant_name, amount, currency_code,
        transaction_date, pending, source_status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'USD', ?, 0, ?, ?)`,
      id,
      `plaid-${id}`,
      organizationId,
      item,
      account,
      name,
      id === "txn-1" ? "Test Cafe" : null,
      amount,
      date,
      status,
      timestamp,
    );
  }
}

function testApp(userId: string) {
  const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
  app.use("*", async (context, next) => {
    context.set("organizationId", "org-1");
    context.set("organizationRole", "member");
    context.set("authSession", {
      session: { activeOrganizationId: "org-1" },
      user: { id: userId, role: "user" },
    } as unknown as AuthSession);
    await next();
  });
  app.route(
    "/api/finance",
    createFinanceRouter(async () => {
      throw new Error("Plaid is not used by these tests.");
    }),
  );
  app.route("/api/inbox", inbox);
  app.route("/api/library/folders", libraryFolders);
  return app;
}

async function applyMigrations(database: Database) {
  const directory = `${import.meta.dir}/../migrations`;
  for (const filename of (await readdir(directory)).sort()) {
    database.exec(await Bun.file(`${directory}/${filename}`).text());
  }
}

function toD1(database: Database) {
  return {
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
