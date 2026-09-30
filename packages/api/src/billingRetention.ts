import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lt,
  notInArray,
  sql,
} from "drizzle-orm";
import {
  freeRetentionDays,
  reconcilePendingCheckoutEntitlements,
} from "./billing";
import { getDb } from "./db";
import { audits, organization, organizationBilling } from "./schema";
import type { Bindings } from "./types";

const retentionBatchSize = 100;
const retentionBatchesPerInvocation = 5;

/** Permanently remove audit history outside a free organization's window. */
export async function purgeExpiredFreeAuditRuns(
  environment: Pick<
    Bindings,
    "DB" | "STRIPE_PRO_PRICE_ID" | "STRIPE_SECRET_KEY"
  >,
  retainedAfter = new Date(
    Date.now() - freeRetentionDays * 24 * 60 * 60 * 1_000,
  ).toISOString(),
) {
  const proPriceId = environment.STRIPE_PRO_PRICE_ID;
  if (!proPriceId) {
    throw new Error(
      "Stripe Pro price configuration is required for retention cleanup.",
    );
  }
  await reconcilePendingCheckoutEntitlements(environment);
  const db = getDb(environment.DB);
  const completedAt = sql`coalesce(${audits.completedAt}, ${audits.updatedAt})`;
  let deleted = 0;
  for (let batch = 0; batch < retentionBatchesPerInvocation; batch += 1) {
    const result = await db
      .delete(audits)
      .where(
        inArray(
          audits.id,
          db
            .select({ id: audits.id })
            .from(audits)
            .innerJoin(organization, eq(organization.id, audits.organizationId))
            .leftJoin(
              organizationBilling,
              eq(organizationBilling.organizationId, audits.organizationId),
            )
            .where(
              and(
                isNull(organization.deletedAt),
                eq(audits.status, "completed"),
                isNull(organizationBilling.pendingCheckoutSessionId),
                sql`not (
                  ${organizationBilling.checkoutClaimId} is not null
                  and coalesce(${organizationBilling.checkoutClaimExpiresAt}, 0) > unixepoch()
                )`,
                sql`not (
                  ${organizationBilling.checkoutDisabledAt} is not null
                  and coalesce(${organizationBilling.checkoutDisabledExpiresAt}, 0) > unixepoch()
                )`,
                lt(
                  sql`datetime(${completedAt})`,
                  sql`datetime(${retainedAfter})`,
                ),
                notInArray(
                  sql`coalesce(${organizationBilling.stripeStatus}, '')`,
                  ["active", "past_due", "trialing"],
                ),
              ),
            )
            .orderBy(asc(completedAt), asc(audits.id))
            .limit(retentionBatchSize),
        ),
      )
      .returning({ id: audits.id });
    deleted += result.length;
    if (result.length < retentionBatchSize) return deleted;
  }
  return deleted;
}
