import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { app } from "./app";
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

  it("requires authentication for the inbox", async () => {
    const response = await app.request("/api/inbox", undefined, authBindings());

    expect(response.status).toBe(401);
    const body: unknown = await response.json();
    expect(body).toEqual({
      error: "Authentication required.",
    });
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
});

function authBindings(): Bindings {
  return {
    AUTH_EMAIL_FROM: "security@auth.tearleads.com",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    BETTER_AUTH_URL: "https://api.test",
    CORS_ORIGIN: "https://app.test",
    DB: new Database(":memory:") as unknown as D1Database,
    EMAIL: {} as SendEmail,
    INBOUND_EMAIL_DOMAIN: "inbox.tearleads.com",
    STORAGE: {} as R2Bucket,
  };
}
