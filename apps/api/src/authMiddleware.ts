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
    const organization = await context.env.DB.prepare(
      `SELECT id FROM organization WHERE slug = ? AND deletedAt IS NULL`,
    )
      .bind(slug)
      .first<{ id: string }>();
    if (organization) targets.add(organization.id);
  }

  const teamId = stringValue(body?.teamId ?? context.req.query("teamId"));
  if (teamId) {
    await addResourceOrganization(
      targets,
      context.env.DB,
      `SELECT organizationId FROM team WHERE id = ?`,
      teamId,
    );
  }

  const invitationId = stringValue(
    body?.invitationId ?? context.req.query("invitationId"),
  );
  if (invitationId) {
    await addResourceOrganization(
      targets,
      context.env.DB,
      `SELECT organizationId FROM invitation WHERE id = ?`,
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
    await addResourceOrganization(
      targets,
      context.env.DB,
      `SELECT organizationId FROM member WHERE id = ?`,
      memberId,
    );
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
  query: string,
  resourceId: string,
) {
  const resource = await database
    .prepare(query)
    .bind(resourceId)
    .first<{ organizationId: string }>();
  if (resource) targets.add(resource.organizationId);
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
