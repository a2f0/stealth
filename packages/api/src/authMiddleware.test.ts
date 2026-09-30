import type { Database, SQLQueryBindings } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { AuthSession } from "./auth";
import {
  type AuthVariables,
  requireAuthOrganizationSeat,
  requireOrganization,
  requireOrganizationPluginAccess,
} from "./authMiddleware";
import { createTestD1, migratedDatabase } from "./testDatabase";
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
      { freeSeatUserId: "owner-id" },
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
      DB: await membershipDatabase(["active-org"], [], [], "owner-id"),
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

  it("rejects organization selectors that conflict with a canonical resource", async () => {
    const bindings = {
      DB: await membershipDatabase(
        ["active-org", "unseated-org"],
        [],
        [],
        "owner-id",
        { invitation: { "invite-unseated": "unseated-org" } },
      ),
    } as Bindings;
    const response = await authOrganizationApp().request(
      "/api/auth/organization/cancel-invitation?organizationId=active-org",
      {
        body: JSON.stringify({ invitationId: "invite-unseated" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
      bindings,
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toEqual({
      error: "Organization selectors do not match.",
    });
  });

  it("lets a verified member leave without a Free-plan seat", async () => {
    const bindings = {
      DB: await membershipDatabase(
        ["active-org"],
        [],
        ["active-org"],
        "owner-id",
      ),
    } as Bindings;
    const response = await combinedAuthOrganizationApp().request(
      "/api/auth/organization/leave",
      {
        body: JSON.stringify({ organizationId: "active-org" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
      bindings,
    );

    expect(response.status).toBe(200);
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

function combinedAuthOrganizationApp() {
  const app = new Hono<{
    Bindings: Bindings;
    Variables: AuthVariables;
  }>();
  app.use("*", async (context, next) => {
    context.set("authSession", {
      session: {
        activeOrganizationId: "active-org",
        twoFactorVerified: true,
      },
      user: {
        defaultOrganizationId: "active-org",
        id: "user-id",
        twoFactorEnabled: true,
      },
    } as unknown as AuthSession);
    await next();
  });
  app.use("*", requireOrganizationPluginAccess, requireAuthOrganizationSeat);
  app.all("*", (context) => context.json({ ok: true }));
  return app;
}

describe("organization two-factor middleware", () => {
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

  it("filters teams without two-factor access or a seat", async () => {
    const response = await pluginRequest(
      "/api/auth/organization/list-user-teams",
      null,
      "active-org",
      ["active-org", "protected-org", "unseated-org"],
      ["protected-org"],
      {},
      [
        { id: "active-team", organizationId: "active-org" },
        { id: "protected-team", organizationId: "protected-org" },
        { id: "unseated-team", organizationId: "unseated-org" },
      ],
      null,
      {
        "active-org": "user-id",
        "protected-org": "user-id",
        "unseated-org": "owner-id",
      },
    );

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toEqual([{ id: "active-team", organizationId: "active-org" }]);
  });

  it("checks the organization of a stale active team", async () => {
    const response = await pluginRequest(
      "/api/auth/organization/list-team-members",
      null,
      "active-org",
      ["active-org", "protected-org"],
      ["protected-org"],
      { team: { "protected-team": "protected-org" } },
      undefined,
      "protected-team",
    );

    expect(response.status).toBe(403);
    const body: unknown = await response.json();
    expect(body).toEqual({
      code: "TWO_FACTOR_SETUP_REQUIRED",
      error: "Set up two-factor authentication before using this organization.",
    });
  });

  it("checks seats against the canonically authorized active team", async () => {
    const response = await pluginRequest(
      "/api/auth/organization/list-team-members",
      null,
      "active-org",
      ["active-org", "unseated-org"],
      [],
      { team: { "unseated-team": "unseated-org" } },
      undefined,
      "unseated-team",
      { "active-org": "user-id", "unseated-org": "owner-id" },
    );

    expect(response.status).toBe(403);
    expect((await response.json()) as unknown).toEqual({
      error:
        "This organization's Free plan includes one user. Ask an owner to upgrade or remove another member.",
    });
  });

  it("checks seats against a nested canonical resource", async () => {
    const response = await pluginRequest(
      "/api/auth/organization/update",
      { data: { teamId: "unseated-team" } },
      "active-org",
      ["active-org", "unseated-org"],
      [],
      { team: { "unseated-team": "unseated-org" } },
      undefined,
      null,
      { "active-org": "user-id", "unseated-org": "owner-id" },
    );

    expect(response.status).toBe(403);
    expect((await response.json()) as unknown).toEqual({
      error:
        "This organization's Free plan includes one user. Ask an owner to upgrade or remove another member.",
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
  freeSeatUserId?: string;
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

async function requestOrganization(
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
    DB: await membershipDatabase(
      memberships,
      deletedMemberships,
      twoFactorState.twoFactorRequired ? memberships : [],
      twoFactorState.freeSeatUserId ?? "user-id",
    ),
  } as Bindings);
}

async function pluginRequest(
  path: string,
  body: Record<string, unknown> | null,
  activeOrganizationId: string | null,
  memberships: string[],
  twoFactorRequiredOrganizations: string[],
  resourceOrganizations: ResourceOrganizations = {},
  responseBody?: unknown,
  activeTeamId: string | null = null,
  freeSeatUserIds: string | Record<string, string> = "user-id",
) {
  const app = new Hono<{
    Bindings: Bindings;
    Variables: AuthVariables;
  }>();
  app.use("*", async (context, next) => {
    context.set("authSession", {
      session: {
        activeOrganizationId,
        activeTeamId,
        twoFactorVerified: false,
      },
      user: {
        defaultOrganizationId: activeOrganizationId,
        id: "user-id",
        twoFactorEnabled: false,
      },
    } as unknown as AuthSession);
    await next();
  });
  app.use(
    "/api/auth/organization/*",
    requireOrganizationPluginAccess,
    requireAuthOrganizationSeat,
  );
  app.all("/api/auth/organization/*", async (context) =>
    context.json(
      responseBody ?? { request: body ? await context.req.json() : null },
    ),
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
      DB: await membershipDatabase(
        memberships,
        [],
        twoFactorRequiredOrganizations,
        freeSeatUserIds,
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

/**
 * A migrated database seeded so each lookup the middleware makes finds its
 * case: the user's memberships (some in deleted organizations or requiring
 * two-factor), each organization's Free-plan seat holder, no billing, and the
 * organizations that own invitations, members, and teams.
 */
async function membershipDatabase(
  memberships: string[],
  deletedMemberships: string[],
  twoFactorRequiredOrganizations: string[],
  freeSeatUserIds: string | Record<string, string> = "user-id",
  resourceOrganizations: ResourceOrganizations = {},
) {
  const database = await migratedDatabase();
  const seatUserFor = (organizationId: string) =>
    typeof freeSeatUserIds === "string"
      ? freeSeatUserIds
      : (freeSeatUserIds[organizationId] ?? "user-id");
  const organizationIds = new Set<string>([
    ...memberships,
    ...deletedMemberships,
    ...twoFactorRequiredOrganizations,
    ...Object.keys(typeof freeSeatUserIds === "string" ? {} : freeSeatUserIds),
    ...[
      resourceOrganizations.invitation,
      resourceOrganizations.member,
      resourceOrganizations.team,
    ].flatMap((records) => Object.values(records ?? {})),
  ]);
  const userIds = new Set(["user-id", "owner-id", "resource-user-id"]);
  for (const organizationId of organizationIds) {
    userIds.add(seatUserFor(organizationId));
  }
  for (const userId of userIds) {
    run(
      database,
      `INSERT INTO user
       (id, name, email, emailVerified, createdAt, updatedAt, role, banned)
       VALUES (?, ?, ?, 1, ?, ?, 'user', 0)`,
      userId,
      userId,
      `${userId}@example.com`,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
  }
  for (const organizationId of organizationIds) {
    seedOrganization(
      database,
      organizationId,
      deletedMemberships.includes(organizationId),
      seatUserFor(organizationId),
    );
  }
  for (const organizationId of [...memberships, ...deletedMemberships]) {
    run(
      database,
      `INSERT INTO member
       (id, organizationId, userId, role, createdAt, twoFactorRequired)
       VALUES (?, ?, 'user-id', 'member', ?, ?)`,
      `${organizationId}-member`,
      organizationId,
      "2026-01-02T00:00:00.000Z",
      twoFactorRequiredOrganizations.includes(organizationId) ? 1 : 0,
    );
  }
  seedResources(database, resourceOrganizations);
  return createTestD1(database);
}

/** Seeds an organization whose Free-plan seat belongs to `seatUserId`. */
function seedOrganization(
  database: Database,
  organizationId: string,
  deleted: boolean,
  seatUserId: string,
) {
  run(
    database,
    `INSERT INTO organization (id, name, slug, createdAt, deletedAt)
     VALUES (?, ?, ?, ?, ?)`,
    organizationId,
    organizationId,
    organizationId,
    "2026-01-01T00:00:00.000Z",
    deleted ? "2026-01-02T00:00:00.000Z" : null,
  );
  if (seatUserId === "user-id") return;
  // An earlier owner holds the seat; the user's own membership comes later.
  run(
    database,
    `INSERT INTO member (id, organizationId, userId, role, createdAt)
     VALUES (?, ?, ?, 'owner', ?)`,
    `${organizationId}-seat`,
    organizationId,
    seatUserId,
    "2026-01-01T00:00:00.000Z",
  );
}

function seedResources(
  database: Database,
  resourceOrganizations: ResourceOrganizations,
) {
  const createdAt = "2026-01-03T00:00:00.000Z";
  for (const [id, organizationId] of Object.entries(
    resourceOrganizations.invitation ?? {},
  )) {
    run(
      database,
      `INSERT INTO invitation
       (id, organizationId, email, role, status, expiresAt, createdAt,
        inviterId)
       VALUES (?, ?, 'invitee@example.com', 'member', 'pending', ?, ?,
               'owner-id')`,
      id,
      organizationId,
      "2099-01-01T00:00:00.000Z",
      createdAt,
    );
  }
  for (const [id, organizationId] of Object.entries(
    resourceOrganizations.member ?? {},
  )) {
    run(
      database,
      `INSERT INTO member (id, organizationId, userId, role, createdAt)
       VALUES (?, ?, 'resource-user-id', 'member', ?)`,
      id,
      organizationId,
      createdAt,
    );
  }
  for (const [id, organizationId] of Object.entries(
    resourceOrganizations.team ?? {},
  )) {
    run(
      database,
      `INSERT INTO team (id, name, organizationId, createdAt)
       VALUES (?, ?, ?, ?)`,
      id,
      id,
      organizationId,
      createdAt,
    );
  }
}

function run(database: Database, query: string, ...values: SQLQueryBindings[]) {
  database.query(query).run(...values);
}
