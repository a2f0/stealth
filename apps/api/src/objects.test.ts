import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { AuthSession } from "./auth";
import type { AuthVariables } from "./authMiddleware";
import { objects } from "./objects";
import type { Bindings } from "./types";

interface ObjectResponse {
  object: {
    filename: string;
    id: string;
    objectKey: string;
  };
}

interface ObjectListResponse {
  objects: Array<{
    contentType: string;
    createdAt: string;
    filename: string;
    id: string;
    objectKey: string;
    size: number;
  }>;
}

describe("organization uploads", () => {
  it("backfills existing uploads and isolates object access", async () => {
    const fixture = await createFixture();
    expect(
      fixture.database
        .query("SELECT organization_id FROM objects WHERE id = ?")
        .get("legacy-object"),
    ).toEqual({ organization_id: "org_user-1" });

    const firstList = await fixture.firstApp.request(
      "/",
      undefined,
      fixture.bindings,
    );
    expect(firstList.status).toBe(200);
    expect((await firstList.json()) as ObjectListResponse).toEqual({
      objects: [
        {
          filename: "legacy.txt",
          id: "legacy-object",
          objectKey: "uploads/legacy-object/legacy.txt",
          contentType: "text/plain",
          size: 6,
          createdAt: "2026-08-18T12:00:00.000Z",
        },
      ],
    });

    const otherObject = await fixture.firstApp.request(
      "/other-object",
      undefined,
      fixture.bindings,
    );
    expect(otherObject.status).toBe(404);

    const form = new FormData();
    form.set("file", new File(["new upload"], "report.txt"));
    const uploaded = await fixture.firstApp.request(
      "/",
      { body: form, method: "POST" },
      fixture.bindings,
    );
    expect(uploaded.status).toBe(201);
    const uploadBody = (await uploaded.json()) as ObjectResponse;
    expect(uploadBody.object.objectKey).toStartWith(
      "organizations/org_user-1/uploads/",
    );
    expect(
      fixture.database
        .query("SELECT organization_id FROM objects WHERE id = ?")
        .get(uploadBody.object.id),
    ).toEqual({ organization_id: "org_user-1" });

    const hiddenFromOtherOrganization = await fixture.secondApp.request(
      `/${uploadBody.object.id}`,
      undefined,
      fixture.bindings,
    );
    expect(hiddenFromOtherOrganization.status).toBe(404);

    const deleted = await fixture.firstApp.request(
      `/${uploadBody.object.id}`,
      { method: "DELETE" },
      fixture.bindings,
    );
    expect(deleted.status).toBe(204);
    expect(fixture.stored.has(uploadBody.object.objectKey)).toBe(false);
  });
});

async function createFixture() {
  const database = new Database(":memory:");
  await applyMigration(database, "0001_create_objects.sql");
  await applyMigration(database, "0003_create_auth.sql");
  insertUser(database, "user-1", "Example Person", "person@example.com");
  await applyMigration(database, "0004_create_organizations.sql");
  database
    .query(
      `INSERT INTO objects
       (id, object_key, filename, content_type, size, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "legacy-object",
      "uploads/legacy-object/legacy.txt",
      "legacy.txt",
      "text/plain",
      6,
      "2026-08-18T12:00:00.000Z",
    );
  await applyMigration(database, "0006_scope_objects_to_organizations.sql");
  addSecondOrganization(database);
  const stored = new Map([
    ["uploads/legacy-object/legacy.txt", new TextEncoder().encode("legacy")],
  ]);
  const bindings = bindingsFor(database, stored);
  return {
    bindings,
    database,
    firstApp: testApp("org_user-1"),
    secondApp: testApp("organization-2"),
    stored,
  };
}

function insertUser(
  database: Database,
  id: string,
  name: string,
  email: string,
) {
  database
    .query(
      `INSERT INTO user
       (id, name, email, emailVerified, createdAt, updatedAt, role, banned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      name,
      email,
      false,
      "2026-08-18T12:00:00.000Z",
      "2026-08-18T12:00:00.000Z",
      "user",
      false,
    );
}

function addSecondOrganization(database: Database) {
  insertUser(database, "user-2", "Another Person", "another@example.com");
  database
    .query(
      `INSERT INTO organization (id, name, slug, createdAt)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      "organization-2",
      "Another Organization",
      "another-organization",
      "2026-08-19T12:00:00.000Z",
    );
  database
    .query(
      `INSERT INTO member (id, organizationId, userId, role, createdAt)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      "member-2",
      "organization-2",
      "user-2",
      "owner",
      "2026-08-19T12:00:00.000Z",
    );
  database
    .query(`UPDATE user SET defaultOrganizationId = ? WHERE id = ?`)
    .run("organization-2", "user-2");
  database
    .query(
      `INSERT INTO objects
       (id, organization_id, object_key, filename, content_type, size,
        created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "other-object",
      "organization-2",
      "organizations/organization-2/uploads/other/file.txt",
      "file.txt",
      "text/plain",
      4,
      "2026-08-19T12:00:00.000Z",
    );
}

function testApp(organizationId: string) {
  const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
  app.use("*", async (context, next) => {
    context.set("organizationId", organizationId);
    context.set("authSession", {
      user: { defaultOrganizationId: organizationId, id: "user", role: "user" },
    } as unknown as AuthSession);
    await next();
  });
  app.route("/", objects);
  return app;
}

function bindingsFor(
  database: Database,
  stored: Map<string, Uint8Array>,
): Bindings {
  return {
    AUTH_EMAIL_FROM: "security@auth.tearleads.com",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    BETTER_AUTH_URL: "https://api.test",
    CORS_ORIGIN: "https://app.test",
    DB: toD1(database),
    EMAIL: {} as SendEmail,
    INBOUND_EMAIL_DOMAIN: "inbox.tearleads.com",
    STORAGE: storageFor(stored),
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

function storageFor(stored: Map<string, Uint8Array>) {
  return {
    delete: async (key: string) => stored.delete(key),
    get: async (key: string) => {
      const content = stored.get(key);
      if (!content) return null;
      return {
        body: new Blob([content]).stream(),
        httpEtag: '"test-etag"',
        writeHttpMetadata: (headers: Headers) => {
          headers.set("content-type", "application/octet-stream");
        },
      };
    },
    put: async (key: string, value: Blob) => {
      stored.set(key, new Uint8Array(await value.arrayBuffer()));
    },
  } as unknown as R2Bucket;
}

async function applyMigration(database: Database, filename: string) {
  database.exec(
    await Bun.file(
      new URL(`../migrations/${filename}`, import.meta.url),
    ).text(),
  );
}
