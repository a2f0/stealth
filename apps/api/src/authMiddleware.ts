import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { AuthSession } from "./auth";
import { createAuth } from "./auth";
import { organizationUserHasSeat } from "./billing";
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
    if (candidates.length === 0) {
      return context.json(
        { error: "A default organization is required." },
        409,
      );
    }
    const placeholders = candidates.map(() => "?").join(", ");
    const memberships = await context.env.DB.prepare(
      `SELECT member."organizationId", member."role"
       FROM "member"
       JOIN "organization"
         ON organization.id = member."organizationId"
       WHERE member."userId" = ?
         AND member."organizationId" IN (${placeholders})
         AND organization."deletedAt" IS NULL`,
    )
      .bind(session.user.id, ...candidates)
      .all<{ organizationId: string; role: string }>();
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
    if (
      !(await organizationUserHasSeat(
        context.env.DB,
        membership.organizationId,
        session.user.id,
        context.env.STRIPE_PRO_PRICE_ID,
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
  },
);

export const requireAuthOrganizationSeat = createMiddleware<AuthEnv>(
  async (context, next) => {
    if (organizationSeatRouteExemptions.has(context.req.path)) return next();
    const session = context.get("authSession");
    const target = await authOrganizationTarget(context, session);
    if (!target) return next();
    if (
      !(await organizationUserHasSeat(
        context.env.DB,
        target,
        session.user.id,
        context.env.STRIPE_PRO_PRICE_ID,
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
    invitationId?: unknown;
    organizationId?: unknown;
    organizationSlug?: unknown;
    teamId?: unknown;
    [key: string]: unknown;
  } | null;
  const explicitOrganizationId = stringValue(
    body?.organizationId ?? context.req.query("organizationId"),
  );
  if (explicitOrganizationId) return explicitOrganizationId;

  const organizationSlug = stringValue(
    body?.organizationSlug ?? context.req.query("organizationSlug"),
  );
  if (organizationSlug) {
    const organization = await context.env.DB.prepare(
      `SELECT id FROM organization WHERE slug = ? AND deletedAt IS NULL`,
    )
      .bind(organizationSlug)
      .first<{ id: string }>();
    if (organization) return organization.id;
  }

  const teamId = stringValue(body?.teamId ?? context.req.query("teamId"));
  if (teamId) {
    const team = await context.env.DB.prepare(
      `SELECT organizationId FROM team WHERE id = ?`,
    )
      .bind(teamId)
      .first<{ organizationId: string }>();
    if (team) return team.organizationId;
  }

  const invitationId = stringValue(
    body?.invitationId ?? context.req.query("invitationId"),
  );
  if (invitationId) {
    const invitation = await context.env.DB.prepare(
      `SELECT organizationId FROM invitation WHERE id = ?`,
    )
      .bind(invitationId)
      .first<{ organizationId: string }>();
    if (invitation) return invitation.organizationId;
  }

  return (
    session.session.activeOrganizationId ??
    session.user.defaultOrganizationId ??
    null
  );
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
