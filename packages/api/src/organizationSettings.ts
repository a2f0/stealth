import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import type { AuthVariables } from "./authMiddleware";
import {
  cancelOrganizationSubscription,
  recoverCheckoutAfterFailedDeletion,
} from "./billing";
import { getDb } from "./db";
import { markOrganizationForDeletion } from "./organizationDeletion";
import {
  canManageOrganization,
  isOrganizationOwner,
  listOrganizationMembers,
} from "./organizationMembers";
import { invitation, member, organization } from "./schema";
import type { Bindings } from "./types";

type OrganizationSettingsEnv = {
  Bindings: Bindings;
  Variables: AuthVariables;
};

const organizationSettings = new Hono<OrganizationSettingsEnv>();

organizationSettings.get("/organizations", async (context) => {
  const userId = context.get("authSession").user.id;
  const organizations = await getDb(context.env.DB)
    .select({ id: organization.id, name: organization.name })
    .from(organization)
    .innerJoin(member, eq(member.organizationId, organization.id))
    .where(and(eq(member.userId, userId), isNull(organization.deletedAt)))
    .orderBy(asc(member.createdAt), asc(member.id));
  return context.json({ organizations });
});

organizationSettings.get("/people", async (context) => {
  const organizationId = context.get("organizationId");
  const memberRole = context.get("organizationRole");
  const canManage = canManageOrganization(memberRole);
  const [members, invitations] = await Promise.all([
    listOrganizationMembers(context.env.DB, organizationId),
    canManage
      ? listPendingInvitations(context.env.DB, organizationId)
      : Promise.resolve([]),
  ]);
  return context.json({
    invitations,
    memberRole,
    members: canManage
      ? members
      : members.map(({ id, role, user }) => ({ id, role, user })),
  });
});

organizationSettings.patch(
  "/people/:memberId/two-factor-required",
  async (context) => {
    if (!canManageOrganization(context.get("organizationRole"))) {
      return context.json(
        { error: "Organization manager access required." },
        403,
      );
    }
    const body: unknown = await context.req.json().catch(() => null);
    if (!isTwoFactorRequirement(body)) {
      return context.json({ error: "A required boolean is required." }, 400);
    }
    const organizationId = context.get("organizationId");
    const memberId = context.req.param("memberId");
    const db = getDb(context.env.DB);
    const target = await db
      .select({ id: member.id })
      .from(member)
      .where(
        and(eq(member.id, memberId), eq(member.organizationId, organizationId)),
      )
      .get();
    if (!target) {
      return context.json({ error: "Organization member not found." }, 404);
    }
    await db
      .update(member)
      .set({ twoFactorRequired: body.required ? 1 : 0 })
      .where(
        and(eq(member.id, memberId), eq(member.organizationId, organizationId)),
      );
    return context.json({ memberId, required: body.required });
  },
);

organizationSettings.delete("/current", async (context) => {
  const organizationId = context.get("organizationId");
  const userId = context.get("authSession").user.id;
  if (!isOrganizationOwner(context.get("organizationRole"))) {
    return context.json(
      { error: "Only an organization owner can delete this organization." },
      403,
    );
  }

  let checkoutGuard: string | null;
  try {
    ({ checkoutGuard } = await cancelOrganizationSubscription(
      context.env,
      organizationId,
    ));
  } catch (cause) {
    console.error("Could not cancel organization billing.", cause);
    return context.json(
      {
        error:
          "The Stripe subscription could not be canceled, so the organization was not deleted.",
      },
      502,
    );
  }

  let deletion: Awaited<ReturnType<typeof markOrganizationForDeletion>>;
  try {
    deletion = await markOrganizationForDeletion(
      context.env.DB,
      organizationId,
      userId,
      checkoutGuard,
    );
  } catch (cause) {
    console.error("Could not record organization deletion.", cause);
    await recoverCheckoutAfterFailedDeletion(
      context.env.DB,
      organizationId,
      checkoutGuard,
    );
    return context.json(
      {
        error:
          "Billing was canceled, but the organization could not be deleted. Checkout was re-enabled so billing can be restarted.",
      },
      500,
    );
  }
  if (!deletion) {
    await recoverCheckoutAfterFailedDeletion(
      context.env.DB,
      organizationId,
      checkoutGuard,
    );
    return context.json({ error: "Organization was already deleted." }, 409);
  }
  return context.json(deletion);
});

async function listPendingInvitations(
  database: D1Database,
  organizationId: string,
) {
  return getDb(database)
    .select({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
    })
    .from(invitation)
    .where(
      and(
        eq(invitation.organizationId, organizationId),
        eq(invitation.status, "pending"),
      ),
    )
    .orderBy(desc(invitation.createdAt));
}

function isTwoFactorRequirement(
  value: unknown,
): value is { required: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    "required" in value &&
    typeof value.required === "boolean"
  );
}

export { organizationSettings };
