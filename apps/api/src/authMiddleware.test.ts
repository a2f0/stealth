import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { AuthSession } from "./auth";
import { type AuthVariables, requireOrganization } from "./authMiddleware";
import type { Bindings } from "./types";

describe("organization middleware", () => {
  it("uses the session's one active organization", async () => {
    const response = await requestOrganization("active-org", "default-org", [
      "active-org",
      "default-org",
    ]);
    const body: unknown = await response.json();
    expect(body).toEqual({
      organizationId: "active-org",
      organizationRole: "member",
    });
  });

  it("falls back to the user's default organization", async () => {
    const response = await requestOrganization(null, "default-org", [
      "default-org",
    ]);
    const body: unknown = await response.json();
    expect(body).toEqual({
      organizationId: "default-org",
      organizationRole: "member",
    });
  });

  it("falls back when the active organization membership is stale", async () => {
    const response = await requestOrganization("removed-org", "default-org", [
      "default-org",
    ]);
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toEqual({
      organizationId: "default-org",
      organizationRole: "member",
    });
  });

  it("rejects membership in a deleted organization", async () => {
    const response = await requestOrganization(
      "deleted-org",
      null,
      [],
      ["deleted-org"],
    );
    expect(response.status).toBe(403);
    const body: unknown = await response.json();
    expect(body).toEqual({
      error: "Organization membership required.",
    });
  });

  it("rejects an organization pointer without a membership", async () => {
    const response = await requestOrganization("private-org", null, []);
    expect(response.status).toBe(403);
    const body: unknown = await response.json();
    expect(body).toEqual({
      error: "Organization membership required.",
    });
  });

  it("requires an organization pointer", async () => {
    const response = await requestOrganization(null, null, []);
    expect(response.status).toBe(409);
    const body: unknown = await response.json();
    expect(body).toEqual({
      error: "A default organization is required.",
    });
  });
});

function testApp(
  activeOrganizationId: string | null,
  defaultOrganizationId: string | null,
) {
  const app = new Hono<{
    Bindings: Bindings;
    Variables: AuthVariables;
  }>();
  app.use("*", async (context, next) => {
    context.set("authSession", {
      session: { activeOrganizationId },
      user: { defaultOrganizationId, id: "user-id" },
    } as unknown as AuthSession);
    await next();
  });
  app.use("*", requireOrganization);
  app.get("/", (context) =>
    context.json({
      organizationId: context.get("organizationId"),
      organizationRole: context.get("organizationRole"),
    }),
  );
  return app;
}

function requestOrganization(
  activeOrganizationId: string | null,
  defaultOrganizationId: string | null,
  memberships: string[],
  deletedMemberships: string[] = [],
) {
  return testApp(activeOrganizationId, defaultOrganizationId).request(
    "/",
    undefined,
    { DB: membershipDatabase(memberships, deletedMemberships) } as Bindings,
  );
}

function membershipDatabase(
  memberships: string[],
  deletedMemberships: string[],
) {
  return {
    prepare: (query: string) => ({
      bind: (userId: string, ...organizationIds: string[]) => ({
        all: async () => ({
          results:
            userId === "user-id"
              ? [...memberships, ...deletedMemberships]
                  .filter(
                    (organizationId) =>
                      organizationIds.includes(organizationId) &&
                      (!deletedMemberships.includes(organizationId) ||
                        !query.includes('organization."deletedAt" IS NULL')),
                  )
                  .map((organizationId) => ({
                    organizationId,
                    role: "member",
                  }))
              : [],
        }),
      }),
    }),
  } as unknown as D1Database;
}
