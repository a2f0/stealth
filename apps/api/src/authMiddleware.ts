import type { Context, Next } from "hono";
import { createMiddleware } from "hono/factory";
import type { AuthSession } from "./auth";
import { createAuth } from "./auth";
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
    return authorizeOrganization(context, next, candidates);
  },
);

const organizationPluginAccessExemptPaths = new Set([
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

export const requireOrganizationPluginAccess = createMiddleware<AuthEnv>(
  async (context, next) => {
    if (organizationPluginAccessExemptPaths.has(context.req.path)) {
      return next();
    }
    const session = context.get("authSession");
    const requestedOrganizationId = await organizationIdFromRequest(context);
    const candidates = requestedOrganizationId
      ? [requestedOrganizationId]
      : organizationCandidates(
          session.session.activeOrganizationId,
          session.user.defaultOrganizationId,
        );
    return authorizeOrganization(context, next, candidates);
  },
);

async function authorizeOrganization(
  context: Context<AuthEnv>,
  next: Next,
  candidates: string[],
) {
  const session = context.get("authSession");
  if (candidates.length === 0) {
    return context.json({ error: "A default organization is required." }, 409);
  }
  const placeholders = candidates.map(() => "?").join(", ");
  const memberships = await context.env.DB.prepare(
    `SELECT member."organizationId", member."role",
              member."twoFactorRequired"
       FROM "member"
       JOIN "organization"
         ON organization.id = member."organizationId"
       WHERE member."userId" = ?
         AND member."organizationId" IN (${placeholders})
         AND organization."deletedAt" IS NULL`,
  )
    .bind(session.user.id, ...candidates)
    .all<{
      organizationId: string;
      role: string;
      twoFactorRequired: boolean | number;
    }>();
  const membershipByOrganization = new Map(
    memberships.results.map((membership) => [
      membership.organizationId,
      membership,
    ]),
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
  context.set("organizationId", membership.organizationId);
  context.set("organizationRole", membership.role);
  return next();
}

async function organizationIdFromRequest(context: Context<AuthEnv>) {
  const searchParams = new URL(context.req.url).searchParams;
  const queryOrganizationId = searchParams.get("organizationId");
  if (queryOrganizationId) return queryOrganizationId;
  const queryOrganizationSlug = searchParams.get("organizationSlug");
  if (queryOrganizationSlug) {
    return organizationIdForSlug(context.env.DB, queryOrganizationSlug);
  }
  const body = await context.req.raw
    .clone()
    .json()
    .catch(() => null);
  if (!isRecord(body)) return undefined;
  const bodyOrganizationId = stringProperty(body, "organizationId");
  if (bodyOrganizationId) return bodyOrganizationId;
  const bodyOrganizationSlug = stringProperty(body, "organizationSlug");
  if (bodyOrganizationSlug) {
    return organizationIdForSlug(context.env.DB, bodyOrganizationSlug);
  }
  const data = Reflect.get(body, "data");
  if (isRecord(data)) {
    const dataOrganizationId = stringProperty(data, "organizationId");
    if (dataOrganizationId) return dataOrganizationId;
  }
  const invitationId = stringProperty(body, "invitationId");
  if (invitationId) {
    return organizationIdForRecord(context.env.DB, "invitation", invitationId);
  }
  const memberId = stringProperty(body, "memberId");
  if (memberId) {
    return organizationIdForRecord(context.env.DB, "member", memberId);
  }
  const teamId = stringProperty(body, "teamId");
  if (teamId) {
    return organizationIdForRecord(context.env.DB, "team", teamId);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringProperty(value: Record<string, unknown>, key: string) {
  const property = value[key];
  return typeof property === "string" && property ? property : undefined;
}

async function organizationIdForRecord(
  database: D1Database,
  table: "invitation" | "member" | "team",
  id: string,
) {
  const record = await database
    .prepare(`SELECT organizationId FROM "${table}" WHERE id = ?`)
    .bind(id)
    .first<{ organizationId: string }>();
  return record?.organizationId;
}

async function organizationIdForSlug(database: D1Database, slug: string) {
  const record = await database
    .prepare("SELECT id AS organizationId FROM organization WHERE slug = ?")
    .bind(slug)
    .first<{ organizationId: string }>();
  return record?.organizationId;
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
