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

  it("requires authentication for the admin organization list", async () => {
    const response = await app.request(
      "/api/admin/organizations",
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
    INBOUND_EMAIL_ADDRESS: "upload@inbox.tearleads.com",
    STORAGE: {} as R2Bucket,
  };
}
