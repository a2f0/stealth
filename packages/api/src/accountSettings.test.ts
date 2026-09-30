import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { accountSettings } from "./accountSettings";
import type { AuthSession } from "./auth";
import type { AuthVariables } from "./authMiddleware";
import { createTestD1 } from "./testDatabase";
import type { Bindings } from "./types";

describe("default organization settings", () => {
  it("saves an explicit choice from the user's active memberships", async () => {
    const fixture = await createFixture();
    const response = await fixture.request("member", "shared");

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toEqual({ defaultOrganizationId: "shared" });
    expect(fixture.defaultFor("member")).toEqual({
      defaultOrganizationId: "shared",
      defaultOrganizationPinned: 1,
    });
    expect(fixture.defaultFor("other")).toEqual({
      defaultOrganizationId: "org_other",
      defaultOrganizationPinned: 0,
    });
  });

  it("rejects organizations the user does not belong to", async () => {
    const fixture = await createFixture();
    const response = await fixture.request("other", "shared");

    expect(response.status).toBe(403);
    expect(fixture.defaultFor("other")).toEqual({
      defaultOrganizationId: "org_other",
      defaultOrganizationPinned: 0,
    });
  });

  it("rejects deleted organizations and invalid input", async () => {
    const fixture = await createFixture();
    fixture.database
      .query("UPDATE organization SET deletedAt = ? WHERE id = ?")
      .run("2026-09-23T00:00:00Z", "shared");

    expect((await fixture.request("member", "shared")).status).toBe(403);
    expect((await fixture.request("member", 123)).status).toBe(400);
    expect(fixture.defaultFor("member")).toEqual({
      defaultOrganizationId: "org_member",
      defaultOrganizationPinned: 0,
    });
  });
});

async function createFixture() {
  const database = new Database(":memory:");
  for (const filename of [
    "0003_create_auth.sql",
    "0004_create_organizations.sql",
    "0010_create_organization_groups.sql",
    "0011_soft_delete_organizations.sql",
    "0040_pin_default_organization.sql",
  ]) {
    database.exec(
      await Bun.file(
        new URL(`../migrations/${filename}`, import.meta.url),
      ).text(),
    );
  }
  const now = "2026-09-23T00:00:00Z";
  for (const id of ["member", "other"]) {
    database
      .query(
        `INSERT INTO user
         (id, name, email, emailVerified, createdAt, updatedAt, role, banned)
         VALUES (?, ?, ?, 1, ?, ?, 'user', 0)`,
      )
      .run(id, id, `${id}@example.com`, now, now);
    database
      .query(
        `INSERT INTO organization (id, name, slug, createdAt)
         VALUES (?, ?, ?, ?)`,
      )
      .run(`org_${id}`, id, `org-${id}`, now);
    database
      .query(
        `INSERT INTO member (id, organizationId, userId, role, createdAt)
         VALUES (?, ?, ?, 'owner', ?)`,
      )
      .run(`member_${id}`, `org_${id}`, id, now);
    database
      .query("UPDATE user SET defaultOrganizationId = ? WHERE id = ?")
      .run(`org_${id}`, id);
  }
  database
    .query(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
    )
    .run("shared", "Shared", "shared", now);
  database
    .query(
      `INSERT INTO member (id, organizationId, userId, role, createdAt)
       VALUES (?, ?, ?, 'member', ?)`,
    )
    .run("shared-member", "shared", "member", now);

  const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
  app.use("*", async (context, next) => {
    context.set("authSession", {
      user: { id: context.req.header("x-test-user") },
    } as AuthSession);
    await next();
  });
  app.route("/", accountSettings);
  const bindings = { DB: createTestD1(database) } as Bindings;
  return {
    database,
    defaultFor: (userId: string) =>
      database
        .query(
          "SELECT defaultOrganizationId, defaultOrganizationPinned FROM user WHERE id = ?",
        )
        .get(userId),
    request: (userId: string, organizationId: unknown) =>
      app.request(
        "/default-organization",
        {
          body: JSON.stringify({ organizationId }),
          headers: {
            "content-type": "application/json",
            "x-test-user": userId,
          },
          method: "PATCH",
        },
        bindings,
      ),
  };
}
