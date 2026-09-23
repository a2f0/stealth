import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readdir } from "node:fs/promises";
import { Hono } from "hono";
import type { AuthSession } from "./auth";
import type { AuthVariables } from "./authMiddleware";
import { equipment } from "./equipment";
import { inbox } from "./inbox";
import type { Bindings } from "./types";

const timestamp = "2026-09-20T12:00:00.000Z";
const rawEmail = [
  "From: Store <orders@store.example>",
  "To: upload@inbox.tearleads.de",
  "Subject: Your laptop receipt",
  "Content-Type: text/plain",
  "",
  "Thanks for your order.",
  "",
].join("\r\n");

interface Equipment {
  assignee: { email: string; id: string; name: string } | null;
  emailCount: number;
  id: string;
  make: string;
  model: string;
  purchaseDate: string | null;
  serialNumber: string | null;
  type: string;
}

const laptop = {
  assigneeId: "member-user",
  make: " Apple ",
  model: "MacBook Pro",
  purchaseDate: "2026-03-01",
  serialNumber: "C02XYZ",
  type: "computer",
};

describe("equipment", () => {
  it("lets managers add, edit, assign, and remove equipment", async () => {
    const { as } = await createFixture();
    const owner = as("owner-user", "owner");

    const created = await owner.json<{ equipment: Equipment }>(
      "POST",
      "/api/equipment",
      laptop,
    );
    expect(created.status).toBe(201);
    expect(created.body.equipment).toMatchObject({
      assignee: { id: "member-user", name: "member-user" },
      emailCount: 0,
      make: "Apple",
      model: "MacBook Pro",
      purchaseDate: "2026-03-01",
      serialNumber: "C02XYZ",
      type: "computer",
    });
    const id = created.body.equipment.id;

    const listing = await owner.json<{
      canManage: boolean;
      equipment: Equipment[];
      members: Array<{ id: string }>;
      types: string[];
    }>("GET", "/api/equipment");
    expect(listing.body.canManage).toBe(true);
    expect(listing.body.types).toEqual(["computer", "cell_phone", "monitor"]);
    expect(listing.body.members.map(({ id }) => id)).toEqual([
      "member-user",
      "owner-user",
    ]);
    expect(listing.body.equipment.map((item) => item.id)).toEqual([id]);

    const unassigned = await owner.json<{ equipment: Equipment }>(
      "PATCH",
      `/api/equipment/${id}`,
      { assigneeId: null },
    );
    expect(unassigned.body.equipment).toMatchObject({
      assignee: null,
      model: "MacBook Pro",
      serialNumber: "C02XYZ",
    });
    const edited = await owner.json<{ equipment: Equipment }>(
      "PATCH",
      `/api/equipment/${id}`,
      { model: "MacBook Air", serialNumber: "", type: "computer" },
    );
    expect(edited.body.equipment).toMatchObject({
      model: "MacBook Air",
      purchaseDate: "2026-03-01",
      serialNumber: null,
    });

    expect((await owner.json("DELETE", `/api/equipment/${id}`)).status).toBe(
      204,
    );
    expect((await owner.json("GET", `/api/equipment/${id}`)).status).toBe(404);
  });

  it("rejects invalid details and assignees outside the organization", async () => {
    const { as } = await createFixture();
    const owner = as("owner-user", "owner");
    for (const change of [
      { type: "tablet" },
      { make: "  " },
      { model: undefined },
      { purchaseDate: "2026-02-30" },
      { serialNumber: "x".repeat(101) },
    ]) {
      expect(
        (await owner.json("POST", "/api/equipment", { ...laptop, ...change }))
          .status,
      ).toBe(400);
    }
    const outsider = await owner.json<{ error: string }>(
      "POST",
      "/api/equipment",
      { ...laptop, assigneeId: "other-user" },
    );
    expect(outsider.status).toBe(400);
    expect(outsider.body.error).toContain("members");

    const created = await owner.json<{ equipment: Equipment }>(
      "POST",
      "/api/equipment",
      { ...laptop, assigneeId: null, purchaseDate: "", serialNumber: null },
    );
    expect(created.body.equipment).toMatchObject({
      assignee: null,
      purchaseDate: null,
      serialNumber: null,
    });
    const id = created.body.equipment.id;
    expect(
      (
        await owner.json("PATCH", `/api/equipment/${id}`, {
          assigneeId: "other-user",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await owner.json<{ equipment: Equipment }>(
          "GET",
          `/api/equipment/${id}`,
        )
      ).body.equipment.assignee,
    ).toBeNull();
  });

  it("lets members view but not change equipment, within their organization", async () => {
    const { as } = await createFixture();
    const owner = as("owner-user", "owner");
    const member = as("member-user", "member");
    const created = await owner.json<{ equipment: Equipment }>(
      "POST",
      "/api/equipment",
      laptop,
    );
    const id = created.body.equipment.id;

    const listing = await member.json<{
      canManage: boolean;
      equipment: Equipment[];
    }>("GET", "/api/equipment");
    expect(listing.body.canManage).toBe(false);
    expect(listing.body.equipment).toHaveLength(1);
    expect((await member.json("GET", `/api/equipment/${id}`)).status).toBe(200);
    expect((await member.json("POST", "/api/equipment", laptop)).status).toBe(
      403,
    );
    expect(
      (await member.json("PATCH", `/api/equipment/${id}`, { make: "Dell" }))
        .status,
    ).toBe(403);
    expect((await member.json("DELETE", `/api/equipment/${id}`)).status).toBe(
      403,
    );

    for (const method of ["GET", "PATCH", "DELETE"]) {
      expect(
        (await owner.json(method, "/api/equipment/equipment-other", {})).status,
      ).toBe(404);
    }
  });

  it("unassigns equipment when its assignee leaves the organization", async () => {
    const { as, database } = await createFixture();
    const owner = as("owner-user", "owner");
    const created = await owner.json<{ equipment: Equipment }>(
      "POST",
      "/api/equipment",
      laptop,
    );
    database.query("DELETE FROM member WHERE userId = 'member-user'").run();
    const detail = await owner.json<{ equipment: Equipment }>(
      "GET",
      `/api/equipment/${created.body.equipment.id}`,
    );
    expect(detail.body.equipment.assignee).toBeNull();
  });

  it("attaches emails and receipts to equipment", async () => {
    const { as, database } = await createFixture();
    const owner = as("owner-user", "owner");
    const member = as("member-user", "member");
    const created = await owner.json<{ equipment: Equipment }>(
      "POST",
      "/api/equipment",
      laptop,
    );
    const id = created.body.equipment.id;

    const linked = await member.json<{
      link: { equipment: { make: string; model: string; type: string } };
    }>("POST", "/api/inbox/email-1/links", {
      targetId: id,
      targetType: "equipment",
    });
    expect(linked.status).toBe(201);
    expect(linked.body.link.equipment).toMatchObject({
      make: "Apple",
      model: "MacBook Pro",
      type: "computer",
    });
    expect(
      (
        await member.json("POST", "/api/inbox/email-1/links", {
          targetId: "equipment-other",
          targetType: "equipment",
        })
      ).status,
    ).toBe(404);

    const detail = await member.json<{
      emails: Array<{ id: string; subject: string }>;
      equipment: Equipment;
    }>("GET", `/api/equipment/${id}`);
    expect(detail.body.equipment.emailCount).toBe(1);
    expect(detail.body.emails).toEqual([
      expect.objectContaining({
        id: "email-1",
        subject: "Your laptop receipt",
      }),
    ]);

    await member.json("DELETE", "/api/inbox/email-1");
    expect(
      (await member.json<{ equipment: Equipment[] }>("GET", "/api/equipment"))
        .body.equipment[0]?.emailCount,
    ).toBe(0);

    await owner.json("DELETE", `/api/equipment/${id}`);
    expect(database.query("SELECT id FROM inbound_email_links").all()).toEqual(
      [],
    );
  });
});

describe("equipment link migration", () => {
  it("keeps existing email links when the link table is rebuilt", async () => {
    const database = new Database(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    await applyMigrations(database, (filename) => filename < "0037");
    seed(database);
    database
      .query(
        `INSERT INTO inbound_email_links
         (id, organization_id, email_id, target_type, target_id, created_by,
          created_at)
         VALUES ('link-1', 'org-1', 'email-1', 'library_folder', 'folder-1',
                 'owner-user', ?)`,
      )
      .run(timestamp);
    await applyMigrations(database, (filename) => filename >= "0037");

    expect(
      database.query("SELECT id, target_type FROM inbound_email_links").all(),
    ).toEqual([{ id: "link-1", target_type: "library_folder" }]);
    database.query("DELETE FROM library_folders WHERE id = 'folder-1'").run();
    expect(database.query("SELECT id FROM inbound_email_links").all()).toEqual(
      [],
    );
  });
});

async function createFixture() {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  await applyMigrations(database, () => true);
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

  function as(userId: string, role: string) {
    const app = testApp(userId, role);
    return {
      json: async <T = unknown>(
        method: string,
        path: string,
        body?: unknown,
      ) => {
        const init: RequestInit = { method };
        if (body !== undefined && method !== "GET") {
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
  for (const id of ["owner-user", "member-user", "other-user"]) {
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
  for (const [id, organizationId, userId, role] of [
    ["member-owner", "org-1", "owner-user", "owner"],
    ["member-member", "org-1", "member-user", "member"],
    ["member-other", "org-2", "other-user", "owner"],
  ] as const) {
    run(
      `INSERT INTO member (id, organizationId, userId, role, createdAt)
       VALUES (?, ?, ?, ?, ?)`,
      id,
      organizationId,
      userId,
      role,
      timestamp,
    );
  }
  run(
    `INSERT INTO inbound_emails
     (id, organization_id, envelope_from, envelope_to, subject,
      raw_object_key, raw_size, received_at)
     VALUES ('email-1', 'org-1', 'orders@store.example',
             'upload@inbox.tearleads.de', 'Your laptop receipt',
             'raw/email-1', 1, ?)`,
    timestamp,
  );
  run(
    `INSERT INTO library_folders
     (id, organization_id, name, created_at, updated_at)
     VALUES ('folder-1', 'org-1', 'Receipts', ?, ?)`,
    timestamp,
    timestamp,
  );
  if (
    database
      .query("SELECT name FROM sqlite_master WHERE name = 'equipment'")
      .get()
  ) {
    run(
      `INSERT INTO equipment
       (id, organization_id, type, make, model, created_at, updated_at)
       VALUES ('equipment-other', 'org-2', 'monitor', 'Dell', 'U2723QE', ?, ?)`,
      timestamp,
      timestamp,
    );
  }
}

function testApp(userId: string, role: string) {
  const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
  app.use("*", async (context, next) => {
    context.set("organizationId", "org-1");
    context.set("organizationRole", role);
    context.set("authSession", {
      session: { activeOrganizationId: "org-1" },
      user: { id: userId, role: "user" },
    } as unknown as AuthSession);
    await next();
  });
  app.route("/api/equipment", equipment);
  app.route("/api/inbox", inbox);
  return app;
}

async function applyMigrations(
  database: Database,
  include: (filename: string) => boolean,
) {
  const directory = `${import.meta.dir}/../migrations`;
  for (const filename of (await readdir(directory)).sort()) {
    if (!include(filename)) continue;
    database.exec(await Bun.file(`${directory}/${filename}`).text());
  }
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
