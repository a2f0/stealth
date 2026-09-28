import { count, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import type { AuthVariables } from "./authMiddleware";
import {
  cancelOrganizationSubscription,
  recoverCheckoutAfterFailedDeletion,
} from "./billing";
import { getDb } from "./db";
import {
  markOrganizationForDeletion,
  restoreOrganization,
} from "./organizationDeletion";
import { member, organization, user } from "./schema";
import type { Bindings } from "./types";

const adminOrganizations = new Hono<{
  Bindings: Bindings;
  Variables: AuthVariables;
}>();

adminOrganizations.get("/", async (context) => {
  const owner = alias(user, "owner");
  const deletedBy = alias(user, "deleted_by");
  const organizations = await getDb(context.env.DB)
    .select({
      createdAt: organization.createdAt,
      deletedByEmail: deletedBy.email,
      deletedByName: deletedBy.name,
      deletedByUserId: organization.deletedByUserId,
      deletedAt: organization.deletedAt,
      id: organization.id,
      memberCount: count(member.id),
      name: organization.name,
      ownerEmail: owner.email,
      ownerName: owner.name,
      slug: organization.slug,
    })
    .from(organization)
    .leftJoin(owner, eq(owner.defaultOrganizationId, organization.id))
    .leftJoin(deletedBy, eq(deletedBy.id, organization.deletedByUserId))
    .leftJoin(member, eq(member.organizationId, organization.id))
    .groupBy(organization.id)
    .orderBy(desc(organization.createdAt))
    .limit(100);

  return context.json({ organizations });
});

adminOrganizations.delete("/:organizationId", async (context) => {
  const organizationId = context.req.param("organizationId");
  const actor = context.get("authSession").user;
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
      actor.id,
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
    const existing = await getDb(context.env.DB)
      .select({ deletedAt: organization.deletedAt })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .get();
    if (!existing) {
      return context.json({ error: "Organization not found." }, 404);
    }
    return context.json(
      { error: "Organization is already marked for deletion." },
      409,
    );
  }

  return context.json({
    ...deletion,
    deletedByEmail: actor.email,
    deletedByName: actor.name,
    deletedByUserId: actor.id,
  });
});

adminOrganizations.post("/:organizationId/restore", async (context) => {
  const organizationId = context.req.param("organizationId");
  const restoration = await restoreOrganization(context.env.DB, organizationId);
  if (!restoration) {
    const existing = await getDb(context.env.DB)
      .select({ deletedAt: organization.deletedAt })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .get();
    if (!existing) {
      return context.json({ error: "Organization not found." }, 404);
    }
    return context.json(
      { error: "Organization is not marked for deletion." },
      409,
    );
  }
  return context.json(restoration);
});

export { adminOrganizations };
