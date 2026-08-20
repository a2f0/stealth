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
    context.set("organizationId", membership.organizationId);
    context.set("organizationRole", membership.role);
    return next();
  },
);

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
