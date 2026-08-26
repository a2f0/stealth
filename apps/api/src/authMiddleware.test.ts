import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { AuthSession } from "./auth";
import {
  type AuthVariables,
  requireAuthOrganizationSeat,
  requireOrganization,
} from "./authMiddleware";
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

  it("rejects an extra Free-plan member without a seat", async () => {
    const response = await requestOrganization(
      "active-org",
      null,
      ["active-org"],
      [],
      "owner-id",
    );
    expect(response.status).toBe(403);
    const body: unknown = await response.json();
    expect(body).toEqual({
      error:
        "This organization's Free plan includes one user. Ask an owner to upgrade or remove another member.",
    });
  });

  it("blocks an unseated member from organization auth data but permits switching", async () => {
    const bindings = {
      DB: membershipDatabase(["active-org"], [], "owner-id"),
    } as Bindings;
    const protectedResponse = await authOrganizationApp().request(
      "/api/auth/organization/list-members?organizationId=active-org",
      undefined,
      bindings,
    );
    expect(protectedResponse.status).toBe(403);
    const switchResponse = await authOrganizationApp().request(
      "/api/auth/organization/set-active",
      {
        body: JSON.stringify({ organizationId: "default-org" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
      bindings,
    );
    expect(switchResponse.status).toBe(200);
  });
});

function authOrganizationApp() {
  const app = new Hono<{
    Bindings: Bindings;
    Variables: AuthVariables;
  }>();
  app.use("*", async (context, next) => {
    context.set("authSession", {
      session: { activeOrganizationId: "active-org" },
      user: {
        defaultOrganizationId: "active-org",
        id: "user-id",
      },
    } as unknown as AuthSession);
    await next();
  });
  app.use("*", requireAuthOrganizationSeat);
  app.all("*", (context) => context.json({ ok: true }));
  return app;
}

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
  freeSeatUserId = "user-id",
) {
  return testApp(activeOrganizationId, defaultOrganizationId).request(
    "/",
    undefined,
    {
      DB: membershipDatabase(memberships, deletedMemberships, freeSeatUserId),
    } as Bindings,
  );
}

function membershipDatabase(
  memberships: string[],
  deletedMemberships: string[],
  freeSeatUserId: string,
) {
  return {
    prepare: (query: string) => ({
      bind: (...values: string[]) => ({
        all: async () => ({
          results:
            values[0] === "user-id"
              ? [...memberships, ...deletedMemberships]
                  .filter(
                    (organizationId) =>
                      values.slice(1).includes(organizationId) &&
                      (!deletedMemberships.includes(organizationId) ||
                        !query.includes('organization."deletedAt" IS NULL')),
                  )
                  .map((organizationId) => ({
                    organizationId,
                    role: "member",
                  }))
              : [],
        }),
        first: async () => {
          if (query.includes("FROM organization_billing")) return null;
          if (query.includes("SELECT userId")) {
            return { userId: freeSeatUserId };
          }
          return null;
        },
      }),
    }),
  } as unknown as D1Database;
}
