import { createMiddleware } from "hono/factory";
import type { AuthSession } from "./auth";
import { createAuth } from "./auth";
import type { Bindings } from "./types";

export interface AuthVariables {
  authSession: AuthSession;
  organizationId: string;
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
      `SELECT "organizationId"
       FROM "member"
       WHERE "userId" = ? AND "organizationId" IN (${placeholders})`,
    )
      .bind(session.user.id, ...candidates)
      .all<{ organizationId: string }>();
    const membershipIds = new Set(
      memberships.results.map(({ organizationId }) => organizationId),
    );
    const organizationId = candidates.find((candidate) =>
      membershipIds.has(candidate),
    );
    if (!organizationId) {
      return context.json({ error: "Organization membership required." }, 403);
    }
    context.set("organizationId", organizationId);
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
