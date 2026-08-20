import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { adminOrganizations } from "./adminOrganizations";
import type { AuthSession } from "./auth";
import type { AuthVariables } from "./authMiddleware";
import type { Bindings } from "./types";

describe("admin organizations", () => {
  it("lists organizations with their owners and member counts", async () => {
    const database = new Database(":memory:");
    database.exec(
      await Bun.file(
        new URL("../migrations/0003_create_auth.sql", import.meta.url),
      ).text(),
    );
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
        "2026-08-18T12:00:00.000Z",
        "2026-08-18T12:00:00.000Z",
        "admin",
        false,
      );
    database.exec(
      await Bun.file(
        new URL("../migrations/0004_create_organizations.sql", import.meta.url),
      ).text(),
    );
    database.exec(
      await Bun.file(
        new URL(
          "../migrations/0010_create_organization_groups.sql",
          import.meta.url,
        ),
      ).text(),
    );
    database.exec(
      await Bun.file(
        new URL(
          "../migrations/0011_soft_delete_organizations.sql",
          import.meta.url,
        ),
      ).text(),
    );
    database.exec(
      await Bun.file(
        new URL(
          "../migrations/0013_track_organization_deletion_actor.sql",
          import.meta.url,
        ),
      ).text(),
    );

    const response = await testApp(database).request("/");

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toEqual({
      organizations: [
        {
          createdAt: "2026-08-18T12:00:00.000Z",
          deletedByEmail: null,
          deletedByName: null,
          deletedByUserId: null,
          deletedAt: null,
          id: "org_user-1",
          memberCount: 1,
          name: "Example Person's Organization",
          ownerEmail: "person@example.com",
          ownerName: "Example Person",
          slug: "personal-user-1",
        },
      ],
    });
  });

  it("marks an organization for deletion and records the admin", async () => {
    const database = await createDeletionFixture();
    const response = await testApp(database).request("/org_member-user", {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      deletedAt: string;
      deletedByEmail: string;
      deletedByName: string;
      deletedByUserId: string;
      organizationId: string;
    };
    expect(body).toEqual({
      deletedAt: body.deletedAt,
      deletedByEmail: "person@example.com",
      deletedByName: "Example Person",
      deletedByUserId: "user-1",
      organizationId: "org_member-user",
    });
    expect(new Date(body.deletedAt).toISOString()).toBe(body.deletedAt);
    expect(
      database
        .query(
          `SELECT deletedAt, deletedByUserId
           FROM organization WHERE id = ?`,
        )
        .get("org_member-user"),
    ).toEqual({
      deletedAt: body.deletedAt,
      deletedByUserId: "user-1",
    });

    const listing = await testApp(database).request("/");
    const listingBody = (await listing.json()) as {
      organizations: Array<Record<string, unknown>>;
    };
    expect(listingBody.organizations[0]).toMatchObject({
      deletedAt: body.deletedAt,
      deletedByEmail: "person@example.com",
      deletedByName: "Example Person",
      deletedByUserId: "user-1",
      id: "org_member-user",
    });
  });
});

async function createDeletionFixture() {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(
    await Bun.file(
      new URL("../migrations/0003_create_auth.sql", import.meta.url),
    ).text(),
  );
  for (const user of [
    ["user-1", "Example Person", "person@example.com", "admin"],
    ["member-user", "Member Person", "member@example.com", "user"],
  ]) {
    database
      .query(
        `INSERT INTO user
         (id, name, email, emailVerified, createdAt, updatedAt, role, banned)
         VALUES (?, ?, ?, 1, ?, ?, ?, 0)`,
      )
      .run(
        user[0] ?? "",
        user[1] ?? "",
        user[2] ?? "",
        "2026-08-18T12:00:00.000Z",
        "2026-08-18T12:00:00.000Z",
        user[3] ?? "user",
      );
  }
  for (const migration of [
    "0004_create_organizations.sql",
    "0010_create_organization_groups.sql",
    "0011_soft_delete_organizations.sql",
    "0013_track_organization_deletion_actor.sql",
  ]) {
    database.exec(
      await Bun.file(
        new URL(`../migrations/${migration}`, import.meta.url),
      ).text(),
    );
  }
  return database;
}

function testApp(database: Database) {
  const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
  app.use("*", async (context, next) => {
    context.set("authSession", {
      user: {
        email: "person@example.com",
        id: "user-1",
        name: "Example Person",
        role: "admin",
      },
    } as AuthSession);
    await next();
  });
  app.route("/", adminOrganizations);
  return {
    request: (path: string, init?: RequestInit) =>
      app.request(path, init, bindingsFor(database)),
  };
}

function bindingsFor(database: Database): Bindings {
  return {
    AUTH_EMAIL_FROM: "security@auth.tearleads.com",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    BETTER_AUTH_URL: "https://api.test",
    CORS_ORIGIN: "https://app.test",
    DB: toD1(database),
    EMAIL: {} as SendEmail,
    INBOUND_EMAIL_DOMAIN: "inbox.tearleads.com",
    STORAGE: {} as R2Bucket,
  };
}

function toD1(database: Database) {
  return {
    batch: async (statements: { execute: () => unknown }[]) =>
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
        execute: () => {
          const result = database.query(query).run(...values);
          return {
            meta: { changes: result.changes },
            results: [],
            success: true,
          };
        },
        first: async () => database.query(query).get(...values),
      };
      return statement;
    },
  } as unknown as D1Database;
}
