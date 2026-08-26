import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { AuthSession } from "./auth";
import {
  type AuthVariables,
  requireOrganization,
  requireOrganizationPluginAccess,
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

  it("requires two-factor setup for a protected membership", async () => {
    const response = await requestOrganization(
      "active-org",
      null,
      ["active-org"],
      [],
      {
        twoFactorRequired: true,
      },
    );

    expect(response.status).toBe(403);
    const body: unknown = await response.json();
    expect(body).toEqual({
      code: "TWO_FACTOR_SETUP_REQUIRED",
      error: "Set up two-factor authentication before using this organization.",
    });
  });

  it("requires the current session to have passed two-factor", async () => {
    const response = await requestOrganization(
      "active-org",
      null,
      ["active-org"],
      [],
      {
        twoFactorEnabled: true,
        twoFactorRequired: true,
      },
    );

    expect(response.status).toBe(403);
    const body: unknown = await response.json();
    expect(body).toEqual({
      code: "TWO_FACTOR_VERIFICATION_REQUIRED",
      error:
        "Sign in with two-factor authentication before using this organization.",
    });
  });

  it("allows a two-factor-verified session into a protected membership", async () => {
    const response = await requestOrganization(
      "active-org",
      null,
      ["active-org"],
      [],
      {
        twoFactorEnabled: true,
        twoFactorRequired: true,
        twoFactorVerified: true,
      },
    );

    expect(response.status).toBe(200);
  });
});

describe("organization plugin middleware", () => {
  it("checks the requested organization instead of the active one", async () => {
    const response = await pluginRequest(
      "/api/auth/organization/update",
      { organizationId: "protected-org" },
      "active-org",
      ["active-org", "protected-org"],
      ["protected-org"],
    );

    expect(response.status).toBe(403);
    const body: unknown = await response.json();
    expect(body).toEqual({
      code: "TWO_FACTOR_SETUP_REQUIRED",
      error: "Set up two-factor authentication before using this organization.",
    });
  });

  it("rejects conflicting organization references", async () => {
    const response = await pluginRequest(
      "/api/auth/organization/update?organizationId=active-org",
      { organizationId: "protected-org" },
      "active-org",
      ["active-org", "protected-org"],
      ["protected-org"],
    );

    expect(response.status).toBe(400);
    const body: unknown = await response.json();
    expect(body).toEqual({
      error: "Conflicting organization references are not allowed.",
    });
  });

  it("checks an organization selected by a query resource id", async () => {
    const response = await pluginRequest(
      "/api/auth/organization/list-team-members?teamId=protected-team",
      null,
      "active-org",
      ["active-org", "protected-org"],
      ["protected-org"],
      { team: { "protected-team": "protected-org" } },
    );

    expect(response.status).toBe(403);
    const body: unknown = await response.json();
    expect(body).toEqual({
      code: "TWO_FACTOR_SETUP_REQUIRED",
      error: "Set up two-factor authentication before using this organization.",
    });
  });

  it("allows organization creation without an existing organization", async () => {
    const response = await pluginRequest(
      "/api/auth/organization/create",
      { name: "Recovery Organization" },
      null,
      [],
      [],
    );

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toEqual({ request: { name: "Recovery Organization" } });
  });
});

interface TwoFactorState {
  twoFactorEnabled?: boolean;
  twoFactorRequired?: boolean;
  twoFactorVerified?: boolean;
}

function testApp(
  activeOrganizationId: string | null,
  defaultOrganizationId: string | null,
  twoFactorState: TwoFactorState,
) {
  const app = new Hono<{
    Bindings: Bindings;
    Variables: AuthVariables;
  }>();
  app.use("*", async (context, next) => {
    context.set("authSession", {
      session: {
        activeOrganizationId,
        twoFactorVerified: twoFactorState.twoFactorVerified ?? false,
      },
      user: {
        defaultOrganizationId,
        id: "user-id",
        twoFactorEnabled: twoFactorState.twoFactorEnabled ?? false,
      },
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
  twoFactorState: TwoFactorState = {},
) {
  return testApp(
    activeOrganizationId,
    defaultOrganizationId,
    twoFactorState,
  ).request("/", undefined, {
    DB: membershipDatabase(
      memberships,
      deletedMemberships,
      twoFactorState.twoFactorRequired ? memberships : [],
    ),
  } as Bindings);
}

function pluginRequest(
  path: string,
  body: Record<string, unknown> | null,
  activeOrganizationId: string | null,
  memberships: string[],
  twoFactorRequiredOrganizations: string[],
  resourceOrganizations: ResourceOrganizations = {},
) {
  const app = new Hono<{
    Bindings: Bindings;
    Variables: AuthVariables;
  }>();
  app.use("*", async (context, next) => {
    context.set("authSession", {
      session: { activeOrganizationId, twoFactorVerified: false },
      user: {
        defaultOrganizationId: activeOrganizationId,
        id: "user-id",
        twoFactorEnabled: false,
      },
    } as unknown as AuthSession);
    await next();
  });
  app.use("/api/auth/organization/*", requireOrganizationPluginAccess);
  app.all("/api/auth/organization/*", async (context) =>
    context.json({ request: body ? await context.req.json() : null }),
  );
  return app.request(
    path,
    body
      ? {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
          method: "POST",
        }
      : undefined,
    {
      DB: membershipDatabase(
        memberships,
        [],
        twoFactorRequiredOrganizations,
        resourceOrganizations,
      ),
    } as Bindings,
  );
}

interface ResourceOrganizations {
  invitation?: Record<string, string>;
  member?: Record<string, string>;
  team?: Record<string, string>;
}

function membershipDatabase(
  memberships: string[],
  deletedMemberships: string[],
  twoFactorRequiredOrganizations: string[],
  resourceOrganizations: ResourceOrganizations = {},
) {
  return {
    prepare: (query: string) => ({
      bind: (firstValue: string, ...organizationIds: string[]) => ({
        all: async () => ({
          results:
            firstValue === "user-id"
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
                    twoFactorRequired:
                      twoFactorRequiredOrganizations.includes(organizationId),
                  }))
              : [],
        }),
        first: async () => {
          for (const table of ["invitation", "member", "team"] as const) {
            if (query.includes(`FROM "${table}"`)) {
              const organizationId = resourceOrganizations[table]?.[firstValue];
              return organizationId ? { organizationId } : null;
            }
          }
          return null;
        },
      }),
    }),
  } as unknown as D1Database;
}
