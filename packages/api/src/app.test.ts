import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { app } from "./app";
import { createAuth } from "./auth";
import { createTestD1 } from "./testDatabase";
import type { Bindings } from "./types";

describe("api", () => {
  it("reports its health", async () => {
    const response = await app.request("/health", undefined, {} as Bindings);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
  });

  it("returns a JSON 404", async () => {
    const response = await app.request("/missing", undefined, {} as Bindings);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('{"error":"Not found."}');
  });

  it("exposes response headers needed by the cross-origin client", async () => {
    const response = await app.request(
      "/api",
      { headers: { Origin: "https://app.test" } },
      authBindings(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://app.test",
    );
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "Retry-After,X-Document-Revision",
    );
  });

  it("requires authentication for the inbox", async () => {
    const response = await app.request("/api/inbox", undefined, authBindings());

    expect(response.status).toBe(401);
    const body: unknown = await response.json();
    expect(body).toEqual({
      error: "Authentication required.",
    });
  });

  it("requires authentication to change the default organization", async () => {
    const response = await app.request(
      "/api/account-settings/default-organization",
      {
        body: JSON.stringify({ organizationId: "organization-id" }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
      authBindings(),
    );

    expect(response.status).toBe(401);
  });

  it("requires authentication to delete an inbox message", async () => {
    const response = await app.request(
      "/api/inbox/email-id",
      { method: "DELETE" },
      authBindings(),
    );

    expect(response.status).toBe(401);
  });

  it("requires authentication to restore an inbox message", async () => {
    const response = await app.request(
      "/api/inbox/email-id/restore",
      { method: "POST" },
      authBindings(),
    );

    expect(response.status).toBe(401);
  });

  it("requires authentication for the admin organization list", async () => {
    const response = await app.request(
      "/api/admin/organizations",
      undefined,
      authBindings(),
    );

    expect(response.status).toBe(401);
  });

  it("requires authentication to mark an organization for deletion", async () => {
    const response = await app.request(
      "/api/admin/organizations/organization-id",
      { method: "DELETE" },
      authBindings(),
    );

    expect(response.status).toBe(401);
  });

  it("requires authentication to restore an organization", async () => {
    const response = await app.request(
      "/api/admin/organizations/organization-id/restore",
      { method: "POST" },
      authBindings(),
    );

    expect(response.status).toBe(401);
  });

  it("requires authentication for audits", async () => {
    const response = await app.request(
      "/api/audits/templates",
      undefined,
      authBindings(),
    );

    expect(response.status).toBe(401);
  });

  it("requires authentication for finance", async () => {
    const response = await app.request(
      "/api/finance",
      undefined,
      authBindings(),
    );

    expect(response.status).toBe(401);
  });

  it("requires authentication for businesses", async () => {
    const response = await app.request(
      "/api/businesses",
      undefined,
      authBindings(),
    );

    expect(response.status).toBe(401);
  });

  it("requires authentication for organization settings", async () => {
    const response = await app.request(
      "/api/organization-settings/people",
      undefined,
      authBindings(),
    );

    expect(response.status).toBe(401);
  });

  it("requires authentication for organization member data", async () => {
    const response = await app.request(
      "/api/auth/organization/list-members",
      undefined,
      authBindings(),
    );

    expect(response.status).toBe(401);
  });

  it("requires authentication for organization plugin mutations", async () => {
    const response = await app.request(
      "/api/auth/organization/update",
      {
        body: JSON.stringify({
          data: { name: "Bypassed Requirement" },
          organizationId: "organization-id",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
      authBindings(),
    );

    expect(response.status).toBe(401);
    const body: unknown = await response.json();
    expect(body).toEqual({ error: "Authentication required." });
  });

  it("blocks protected mutations from an unverified authenticated session", async () => {
    const fixture = await protectedOrganizationFixture();
    const headers = {
      "content-type": "application/json",
      cookie: fixture.cookie,
      origin: "https://app.test",
    };

    const customMutation = await app.request(
      `/api/organization-settings/people/${fixture.memberId}/two-factor-required`,
      {
        body: JSON.stringify({ required: false }),
        headers,
        method: "PATCH",
      },
      fixture.bindings,
    );
    expect(customMutation.status).toBe(403);
    expect(await customMutation.json()).toMatchObject({
      code: "TWO_FACTOR_SETUP_REQUIRED",
    });
    expect(
      fixture.database
        .query("SELECT twoFactorRequired FROM member WHERE id = ?")
        .get(fixture.memberId),
    ).toEqual({ twoFactorRequired: 1 });

    const pluginMutation = await app.request(
      "/api/auth/organization/leave",
      {
        body: JSON.stringify({ organizationId: fixture.organizationId }),
        headers,
        method: "POST",
      },
      fixture.bindings,
    );
    expect(pluginMutation.status).toBe(403);
    expect(await pluginMutation.json()).toMatchObject({
      code: "TWO_FACTOR_SETUP_REQUIRED",
    });
    expect(
      fixture.database
        .query(
          "SELECT COUNT(*) AS count FROM member WHERE id = ? AND organizationId = ?",
        )
        .get(fixture.memberId, fixture.organizationId),
    ).toEqual({ count: 1 });
  });
});

function authBindings(
  database: Database = new Database(":memory:"),
  useD1 = false,
): Bindings {
  return {
    AUTH_EMAIL_FROM: "security@auth.tearleads.de",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    BETTER_AUTH_URL: "https://api.test",
    CORS_ORIGIN: "https://app.test",
    DB: useD1 ? createTestD1(database) : (database as unknown as D1Database),
    EMAIL: {
      send: async () => ({ messageId: "test-message" }),
    } as unknown as SendEmail,
    IMAGES: {} as ImagesBinding,
    INBOUND_EMAIL_DOMAIN: "inbox.tearleads.de",
    STORAGE: {} as R2Bucket,
  };
}

async function protectedOrganizationFixture() {
  const database = new Database(":memory:");
  for (const filename of [
    "0003_create_auth.sql",
    "0004_create_organizations.sql",
    "0008_keep_organization_defaults_valid.sql",
    "0010_create_organization_groups.sql",
    "0011_soft_delete_organizations.sql",
    "0020_add_two_factor_authentication.sql",
    "0021_track_terms_acceptance.sql",
    "0031_require_member_two_factor.sql",
    "0040_pin_default_organization.sql",
  ]) {
    database.exec(
      await Bun.file(
        new URL(`../migrations/${filename}`, import.meta.url),
      ).text(),
    );
  }
  const bindings = authBindings(database, true);
  const pending: Promise<unknown>[] = [];
  const auth = createAuth(bindings, (promise) => pending.push(promise));
  const authRequest = (path: string, body: Record<string, unknown>) =>
    auth.handler(
      new Request(`https://api.test/api/auth${path}`, {
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          origin: "https://app.test",
        },
        method: "POST",
      }),
    );
  const email = "protected@example.com";
  const password = "correct horse battery staple";
  const signUp = await authRequest("/sign-up/email", {
    email,
    name: "Protected Person",
    password,
    termsAccepted: true,
  });
  expect(signUp.status).toBe(200);
  await Promise.all(pending);
  const signIn = await authRequest("/sign-in/email", { email, password });
  expect(signIn.status).toBe(200);
  const cookie = signIn.headers.get("set-cookie");
  expect(cookie).toBeTruthy();
  const membership = database
    .query(
      `SELECT member.id AS memberId, member.organizationId
       FROM member JOIN user ON user.id = member.userId
       WHERE user.email = ?`,
    )
    .get(email) as { memberId: string; organizationId: string };
  database
    .query("UPDATE member SET twoFactorRequired = 1 WHERE id = ?")
    .run(membership.memberId);
  return {
    bindings,
    cookie: cookie ?? "",
    database,
    ...membership,
  };
}
