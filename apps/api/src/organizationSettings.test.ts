import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { AuthSession } from "./auth";
import type { AuthVariables } from "./authMiddleware";
import { organizationSettings } from "./organizationSettings";
import type { Bindings } from "./types";

const targetOrganizationId = "org_owner-user";
const fallbackOrganizationId = "org_member-user";

describe("organization deletion", () => {
  it("only lets an organization owner delete the organization", async () => {
    const fixture = await createFixture();
    const response = await fixture
      .app("member-user", "member")
      .request("/current", { method: "DELETE" });

    expect(response.status).toBe(403);
    const body: unknown = await response.json();
    expect(body).toEqual({
      error: "Only an organization owner can delete this organization.",
    });
    expect(
      fixture.database
        .query("SELECT deletedAt FROM organization WHERE id = ?")
        .get(targetOrganizationId),
    ).toEqual({ deletedAt: null });
  });

  it("soft-deletes the organization and redirects active pointers", async () => {
    const fixture = await createFixture();
    const response = await fixture
      .app("owner-user", "owner")
      .request("/current", { method: "DELETE" });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      deletedAt: string;
      organizationId: string;
    };
    expect(body.organizationId).toBe(targetOrganizationId);
    expect(new Date(body.deletedAt).toISOString()).toBe(body.deletedAt);
    expect(
      fixture.database
        .query(
          `SELECT deletedAt, deletedByUserId
           FROM organization WHERE id = ?`,
        )
        .get(targetOrganizationId),
    ).toEqual({
      deletedAt: body.deletedAt,
      deletedByUserId: "owner-user",
    });
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM member WHERE organizationId = ?")
        .get(targetOrganizationId),
    ).toEqual({ count: 2 });
    expect(
      fixture.database
        .query("SELECT status FROM invitation WHERE id = ?")
        .get("pending-invitation"),
    ).toEqual({ status: "canceled" });
    expect(
      fixture.database
        .query(
          `SELECT activeOrganizationId, activeTeamId
           FROM session WHERE userId = ?`,
        )
        .get("owner-user"),
    ).toEqual({
      activeOrganizationId: fallbackOrganizationId,
      activeTeamId: null,
    });

    const listing = await fixture
      .app("owner-user", "owner")
      .request("/organizations");
    const listingBody: unknown = await listing.json();
    expect(listingBody).toEqual({
      organizations: [
        {
          id: fallbackOrganizationId,
          name: "member-user's Organization",
        },
      ],
    });

    fixture.database
      .query("DELETE FROM organization WHERE id = ?")
      .run(targetOrganizationId);
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM member WHERE organizationId = ?")
        .get(targetOrganizationId),
    ).toEqual({ count: 0 });
    expect(
      fixture.database
        .query(
          "SELECT COUNT(*) AS count FROM invitation WHERE organizationId = ?",
        )
        .get(targetOrganizationId),
    ).toEqual({ count: 0 });
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM team WHERE organizationId = ?")
        .get(targetOrganizationId),
    ).toEqual({ count: 0 });
    expect(
      fixture.database.query("SELECT COUNT(*) AS count FROM user").get(),
    ).toEqual({ count: 2 });
  });
});

async function createFixture() {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  await applyMigration(database, "0003_create_auth.sql");
  insertUser(database, "owner-user");
  insertUser(database, "member-user");
  await applyMigration(database, "0004_create_organizations.sql");
  database
    .query(
      `INSERT INTO member
       (id, organizationId, userId, role, createdAt)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run("target-member", targetOrganizationId, "member-user", "member", now());
  database
    .query(
      `INSERT INTO member
       (id, organizationId, userId, role, createdAt)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      "fallback-member",
      fallbackOrganizationId,
      "owner-user",
      "member",
      now(),
    );
  database
    .query(
      `INSERT INTO invitation
       (id, organizationId, email, role, status, expiresAt, createdAt, inviterId)
       VALUES (?, ?, ?, 'member', 'pending', ?, ?, ?)`,
    )
    .run(
      "pending-invitation",
      targetOrganizationId,
      "invited@example.com",
      "2026-08-30T12:00:00.000Z",
      now(),
      "owner-user",
    );
  await applyMigration(database, "0010_create_organization_groups.sql");
  await applyMigration(database, "0011_soft_delete_organizations.sql");
  await applyMigration(database, "0013_track_organization_deletion_actor.sql");
  insertSession(database, "owner-user", targetOrganizationId);
  insertSession(database, "member-user", targetOrganizationId);
  const bindings = { DB: toD1(database) } as Bindings;
  return {
    app: (userId: string, organizationRole: string) =>
      testApp(bindings, userId, organizationRole),
    database,
  };
}

function testApp(bindings: Bindings, userId: string, organizationRole: string) {
  const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
  app.use("*", async (context, next) => {
    context.set("organizationId", targetOrganizationId);
    context.set("organizationRole", organizationRole);
    context.set("authSession", {
      user: { id: userId, role: "user" },
    } as AuthSession);
    await next();
  });
  app.route("/", organizationSettings);
  return {
    request: (path: string, init?: RequestInit) =>
      app.request(path, init, bindings),
  };
}

function insertUser(database: Database, id: string) {
  database
    .query(
      `INSERT INTO user
       (id, name, email, emailVerified, createdAt, updatedAt, role, banned)
       VALUES (?, ?, ?, 1, ?, ?, 'user', 0)`,
    )
    .run(id, id, `${id}@example.com`, now(), now());
}

function insertSession(
  database: Database,
  userId: string,
  activeOrganizationId: string,
) {
  database
    .query(
      `INSERT INTO session
       (id, expiresAt, token, createdAt, updatedAt, userId,
        activeOrganizationId, activeTeamId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `session-${userId}`,
      "2027-08-20T12:00:00.000Z",
      `token-${userId}`,
      now(),
      now(),
      userId,
      activeOrganizationId,
      `team_finance_${activeOrganizationId}`,
    );
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
        all: async () => ({ results: database.query(query).all(...values) }),
        bind: (...nextValues: SQLQueryBindings[]) => {
          values = nextValues;
          return statement;
        },
        execute: () => {
          const result = database.query(query).run(...values);
          return {
            meta: { changes: result.changes },
            results: [],
            success: true,
          };
        },
        first: async () => database.query(query).get(...values),
        run: async () => database.query(query).run(...values),
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

function now() {
  return "2026-08-20T12:00:00.000Z";
}
