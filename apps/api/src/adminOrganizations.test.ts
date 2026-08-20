import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { adminOrganizations } from "./adminOrganizations";
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

    const response = await adminOrganizations.request(
      "/",
      undefined,
      bindingsFor(database),
    );

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toEqual({
      organizations: [
        {
          createdAt: "2026-08-18T12:00:00.000Z",
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
});

function bindingsFor(database: Database): Bindings {
  return {
    AUTH_EMAIL_FROM: "security@auth.tearleads.com",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    BETTER_AUTH_URL: "https://api.test",
    CORS_ORIGIN: "https://app.test",
    DB: toD1(database),
    EMAIL: {} as SendEmail,
    INBOUND_EMAIL_ADDRESS: "upload@inbox.tearleads.com",
    STORAGE: {} as R2Bucket,
  };
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
      };
      return statement;
    },
  } as unknown as D1Database;
}
