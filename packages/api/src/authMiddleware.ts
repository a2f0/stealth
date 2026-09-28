import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Context, Next } from "hono";
import { createMiddleware } from "hono/factory";
import type { AuthSession } from "./auth";
import { createAuth } from "./auth";
import { organizationUserHasSeat } from "./billing";
import { getDb } from "./db";
import { invitation, member, organization, team } from "./schema";
import type { Bindings } from "./types";

export interface AuthVariables {
  authSession: AuthSession;
  organizationId: string;
  organizationRole: string;
}

type AuthEnv = {
  Bindings: Bindings;
  Variables: AuthVariables;
};

const organizationSeatRouteExemptions = new Set([
  "/api/auth/organization/accept-invitation",
  "/api/auth/organization/check-slug",
  "/api/auth/organization/create",
  "/api/auth/organization/get-invitation",
  "/api/auth/organization/leave",
  "/api/auth/organization/list",
  "/api/auth/organization/list-user-invitations",
  "/api/auth/organization/reject-invitation",
  "/api/auth/organization/set-active",
]);

export const requireAuth = createMiddleware<AuthEnv>(async (context, next) => {
  const auth = createAuth(context.env, (promise) =>
    context.executionCtx.waitUntil(promise),
  );
  const session = await auth.api.getSession({
    headers: context.req.raw.headers,
  });

  if (!session) {
    return context.json({ error: "Authentication required." }, 401);
  }

  context.set("authSession", session as AuthSession);
  return next();
});

export const requireOrganization = createMiddleware<AuthEnv>(
  async (context, next) => {
    const session = context.get("authSession");
    const candidates = organizationCandidates(
      session.session.activeOrganizationId,
      session.user.defaultOrganizationId,
    );
    return authorizeOrganization(context, next, candidates, true);
  },
);

const organizationPluginAccessExemptPaths = new Set([
  "/api/auth/organization/accept-invitation",
  "/api/auth/organization/check-slug",
  "/api/auth/organization/create",
  "/api/auth/organization/get-invitation",
  "/api/auth/organization/list",
  "/api/auth/organization/list-user-invitations",
  "/api/auth/organization/reject-invitation",
  "/api/auth/organization/set-active",
]);

export const requireOrganizationPluginAccess = createMiddleware<AuthEnv>(
  async (context, next) => {
    if (organizationPluginAccessExemptPaths.has(context.req.path)) {
      return next();
    }
    const session = context.get("authSession");
    if (listsCurrentUsersTeamsAcrossOrganizations(context, session.user.id)) {
      return filterTeamsRequiringAccess(context, next);
    }
    const requestedOrganizationIds = await organizationIdsFromRequest(
      context,
      session.session.activeTeamId,
    );
    if (requestedOrganizationIds.length > 1) {
      return context.json(
        { error: "Conflicting organization references are not allowed." },
        400,
      );
    }
    const requestedOrganizationId = requestedOrganizationIds[0];
    const candidates = requestedOrganizationId
      ? [requestedOrganizationId]
      : organizationCandidates(
          session.session.activeOrganizationId,
          session.user.defaultOrganizationId,
        );
    return authorizeOrganization(context, next, candidates, false);
  },
);

function listsCurrentUsersTeamsAcrossOrganizations(
  context: Context<AuthEnv>,
  currentUserId: string,
) {
  if (
    context.req.path !== "/api/auth/organization/list-user-teams" ||
    context.req.method !== "GET"
  ) {
    return false;
  }
  const searchParams = new URL(context.req.url).searchParams;
  return (
    !searchParams.has("organizationId") &&
    (!searchParams.has("userId") ||
      searchParams.get("userId") === currentUserId)
  );
}

async function filterTeamsRequiringAccess(
  context: Context<AuthEnv>,
  next: Next,
) {
  const session = context.get("authSession");
  const memberships = await getDb(context.env.DB)
    .select({
      organizationId: member.organizationId,
      twoFactorRequired: member.twoFactorRequired,
    })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(
      and(eq(member.userId, session.user.id), isNull(organization.deletedAt)),
    );
  const allowedOrganizationIds = new Set<string>();
  for (const membership of memberships) {
    if (
      membership.twoFactorRequired &&
      (!session.user.twoFactorEnabled || !session.session.twoFactorVerified)
    ) {
      continue;
    }
    if (
      await organizationUserHasSeat(
        context.env.DB,
        membership.organizationId,
        session.user.id,
        context.env.STRIPE_PRO_PRICE_ID,
        context.env.STRIPE_PRO_LEGACY_PRICE_IDS,
      )
    ) {
      allowedOrganizationIds.add(membership.organizationId);
    }
  }
  await next();
  const response = context.res;
  if (!response.ok) return;
  const teams: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  if (!Array.isArray(teams)) return;
  const filteredTeams = teams.filter(
    (team) =>
      isRecord(team) &&
      allowedOrganizationIds.has(stringProperty(team, "organizationId") ?? ""),
  );
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  context.res = new Response(JSON.stringify(filteredTeams), {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

async function authorizeOrganization(
  context: Context<AuthEnv>,
  next: Next,
  candidates: string[],
  requireSeat: boolean,
) {
  const session = context.get("authSession");
  if (candidates.length === 0) {
    return context.json({ error: "A default organization is required." }, 409);
  }
  const memberships = await getDb(context.env.DB)
    .select({
      organizationId: member.organizationId,
      role: member.role,
      twoFactorRequired: member.twoFactorRequired,
    })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(
      and(
        eq(member.userId, session.user.id),
        inArray(member.organizationId, candidates),
        isNull(organization.deletedAt),
      ),
    );
  const membershipByOrganization = new Map(
    memberships.map((membership) => [membership.organizationId, membership]),
  );
  const membership = candidates
    .map((candidate) => membershipByOrganization.get(candidate))
    .find((candidate) => candidate !== undefined);
  if (!membership) {
    return context.json({ error: "Organization membership required." }, 403);
  }
  if (membership.twoFactorRequired) {
    if (!session.user.twoFactorEnabled) {
      return context.json(
        {
          code: "TWO_FACTOR_SETUP_REQUIRED",
          error:
            "Set up two-factor authentication before using this organization.",
        },
        403,
      );
    }
    if (!session.session.twoFactorVerified) {
      return context.json(
        {
          code: "TWO_FACTOR_VERIFICATION_REQUIRED",
          error:
            "Sign in with two-factor authentication before using this organization.",
        },
        403,
      );
    }
  }
  if (
    requireSeat &&
    !(await organizationUserHasSeat(
      context.env.DB,
      membership.organizationId,
      session.user.id,
      context.env.STRIPE_PRO_PRICE_ID,
      context.env.STRIPE_PRO_LEGACY_PRICE_IDS,
    ))
  ) {
    return context.json(
      {
        error:
          "This organization's Free plan includes one user. Ask an owner to upgrade or remove another member.",
      },
      403,
    );
  }
  context.set("organizationId", membership.organizationId);
  context.set("organizationRole", membership.role);
  return next();
}

async function organizationIdsFromRequest(
  context: Context<AuthEnv>,
  activeTeamId: string | null | undefined,
) {
  const organizationIds: string[] = [];
  const addOrganizationId = (organizationId: string | undefined) => {
    if (organizationId && !organizationIds.includes(organizationId)) {
      organizationIds.push(organizationId);
    }
  };
  const searchParams = new URL(context.req.url).searchParams;
  addOrganizationId(searchParams.get("organizationId") ?? undefined);
  const queryOrganizationSlug = searchParams.get("organizationSlug");
  if (queryOrganizationSlug) {
    addOrganizationId(
      await organizationIdForSlug(context.env.DB, queryOrganizationSlug),
    );
  }
  for (const [table, key] of organizationResourceSelectors) {
    const resourceId = searchParams.get(key);
    if (resourceId) {
      addOrganizationId(
        await organizationIdForRecord(context.env.DB, table, resourceId),
      );
    }
  }
  if (
    activeTeamId &&
    organizationPluginPathsUsingActiveTeam.has(context.req.path) &&
    !searchParams.has("teamId")
  ) {
    addOrganizationId(
      await organizationIdForRecord(context.env.DB, "team", activeTeamId),
    );
  }
  const body = await context.req.raw
    .clone()
    .json()
    .catch(() => null);
  if (!isRecord(body)) return organizationIds;
  await addBodyOrganizationIds(body);
  const data = Reflect.get(body, "data");
  if (isRecord(data)) {
    await addBodyOrganizationIds(data);
  }
  return organizationIds;

  async function addBodyOrganizationIds(record: Record<string, unknown>) {
    addOrganizationId(stringProperty(record, "organizationId"));
    const organizationSlug = stringProperty(record, "organizationSlug");
    if (organizationSlug) {
      addOrganizationId(
        await organizationIdForSlug(context.env.DB, organizationSlug),
      );
    }
    for (const [table, key] of organizationResourceSelectors) {
      const resourceId = stringProperty(record, key);
      if (resourceId) {
        addOrganizationId(
          await organizationIdForRecord(context.env.DB, table, resourceId),
        );
      }
    }
  }
}

const organizationResourceSelectors = [
  ["invitation", "invitationId"],
  ["member", "memberId"],
  ["team", "teamId"],
] as const;

const organizationResourceTables = { invitation, member, team };

const organizationPluginPathsUsingActiveTeam = new Set([
  "/api/auth/organization/get-active-team",
  "/api/auth/organization/list-team-members",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringProperty(value: Record<string, unknown>, key: string) {
  const property = value[key];
  return typeof property === "string" && property ? property : undefined;
}

async function organizationIdForRecord(
  database: D1Database,
  table: keyof typeof organizationResourceTables,
  id: string,
) {
  const resource = organizationResourceTables[table];
  const record = await getDb(database)
    .select({ organizationId: resource.organizationId })
    .from(resource)
    .where(eq(resource.id, id))
    .get();
  return record?.organizationId;
}

async function organizationIdForSlug(database: D1Database, slug: string) {
  const record = await getDb(database)
    .select({ organizationId: organization.id })
    .from(organization)
    .where(eq(organization.slug, slug))
    .get();
  return record?.organizationId;
}

export const requireAuthOrganizationSeat = createMiddleware<AuthEnv>(
  async (context, next) => {
    if (organizationSeatRouteExemptions.has(context.req.path)) return next();
    const session = context.get("authSession");
    if (listsCurrentUsersTeamsAcrossOrganizations(context, session.user.id)) {
      return next();
    }
    const authorizedOrganizationId = context.get("organizationId");
    const target = authorizedOrganizationId
      ? { conflict: false, organizationId: authorizedOrganizationId }
      : await authOrganizationTarget(context, session);
    if (target.conflict) {
      return context.json(
        { error: "Organization selectors do not match." },
        400,
      );
    }
    if (!target.organizationId) return next();
    if (
      !(await organizationUserHasSeat(
        context.env.DB,
        target.organizationId,
        session.user.id,
        context.env.STRIPE_PRO_PRICE_ID,
        context.env.STRIPE_PRO_LEGACY_PRICE_IDS,
      ))
    ) {
      return context.json(
        {
          error:
            "This organization's Free plan includes one user. Ask an owner to upgrade or remove another member.",
        },
        403,
      );
    }
    return next();
  },
);

async function authOrganizationTarget(
  context: Context<AuthEnv>,
  session: AuthSession,
) {
  const body = (await context.req.raw
    .clone()
    .json()
    .catch(() => null)) as {
    data?: { organizationId?: unknown; [key: string]: unknown };
    invitationId?: unknown;
    memberId?: unknown;
    memberIdOrEmail?: unknown;
    organizationId?: unknown;
    organizationSlug?: unknown;
    teamId?: unknown;
    [key: string]: unknown;
  } | null;
  const targets = new Set<string>();
  addStringValue(targets, body?.organizationId);
  addStringValue(targets, body?.data?.organizationId);
  addStringValue(targets, context.req.query("organizationId"));

  for (const slugValue of [
    body?.organizationSlug,
    context.req.query("organizationSlug"),
  ]) {
    const slug = stringValue(slugValue);
    if (!slug) continue;
    const slugOrganization = await getDb(context.env.DB)
      .select({ id: organization.id })
      .from(organization)
      .where(and(eq(organization.slug, slug), isNull(organization.deletedAt)))
      .get();
    if (slugOrganization) targets.add(slugOrganization.id);
  }

  const teamId = stringValue(body?.teamId ?? context.req.query("teamId"));
  if (teamId) {
    await addResourceOrganization(targets, context.env.DB, "team", teamId);
  }

  const invitationId = stringValue(
    body?.invitationId ?? context.req.query("invitationId"),
  );
  if (invitationId) {
    await addResourceOrganization(
      targets,
      context.env.DB,
      "invitation",
      invitationId,
    );
  }

  const memberIdOrEmail = stringValue(body?.memberIdOrEmail);
  const memberId =
    stringValue(body?.memberId) ??
    (memberIdOrEmail && !memberIdOrEmail.includes("@")
      ? memberIdOrEmail
      : null);
  if (memberId) {
    await addResourceOrganization(targets, context.env.DB, "member", memberId);
  }

  if (targets.size > 0) {
    return {
      conflict: targets.size > 1,
      organizationId: targets.values().next().value ?? null,
    };
  }
  return {
    conflict: false,
    organizationId:
      session.session.activeOrganizationId ??
      session.user.defaultOrganizationId ??
      null,
  };
}

async function addResourceOrganization(
  targets: Set<string>,
  database: D1Database,
  table: keyof typeof organizationResourceTables,
  resourceId: string,
) {
  const organizationId = await organizationIdForRecord(
    database,
    table,
    resourceId,
  );
  if (organizationId !== undefined) targets.add(organizationId);
}

function addStringValue(targets: Set<string>, value: unknown) {
  const string = stringValue(value);
  if (string) targets.add(string);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function organizationCandidates(
  activeOrganizationId: string | null | undefined,
  defaultOrganizationId: string | null | undefined,
) {
  const candidates: string[] = [];
  for (const organizationId of [activeOrganizationId, defaultOrganizationId]) {
    if (organizationId && !candidates.includes(organizationId)) {
      candidates.push(organizationId);
    }
  }
  return candidates;
}

export function requireRole(role: "admin" | "user") {
  return createMiddleware<AuthEnv>(async (context, next) => {
    const roles = context.get("authSession").user.role.split(",");

    if (!roles.includes(role)) {
      return context.json({ error: "Insufficient permissions." }, 403);
    }

    return next();
  });
}
