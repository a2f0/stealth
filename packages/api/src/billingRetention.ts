import {
  freeRetentionDays,
  lapsedRetentionGraceDays,
  reconcilePendingCheckoutEntitlements,
} from "./billing";
import type { Bindings } from "./types";

const retentionBatchSize = 100;
const retentionBatchesPerInvocation = 5;
const dayMilliseconds = 24 * 60 * 60 * 1_000;

/**
 * Permanently remove audit history outside a free organization's window.
 * Organizations whose paid plan ended after `paidEndedAfter` are still in
 * their grace period and keep all history.
 */
export async function purgeExpiredFreeAuditRuns(
  environment: Pick<
    Bindings,
    "DB" | "STRIPE_PRO_PRICE_ID" | "STRIPE_SECRET_KEY"
  >,
  retainedAfter = new Date(
    Date.now() - freeRetentionDays * dayMilliseconds,
  ).toISOString(),
  paidEndedAfter = new Date(
    Date.now() - lapsedRetentionGraceDays * dayMilliseconds,
  ).toISOString(),
) {
  const proPriceId = environment.STRIPE_PRO_PRICE_ID;
  if (!proPriceId) {
    throw new Error(
      "Stripe Pro price configuration is required for retention cleanup.",
    );
  }
  await reconcilePendingCheckoutEntitlements(environment);
  let deleted = 0;
  for (let batch = 0; batch < retentionBatchesPerInvocation; batch += 1) {
    const result = await environment.DB.prepare(
      `DELETE FROM audits
       WHERE id IN (
         SELECT audit.id
         FROM audits AS audit
         JOIN organization AS organization
           ON organization.id = audit.organization_id
         LEFT JOIN organization_billing AS billing
           ON billing.organization_id = audit.organization_id
         WHERE organization.deletedAt IS NULL
           AND audit.status = 'completed'
           AND billing.pending_checkout_session_id IS NULL
           AND NOT (
             billing.checkout_claim_id IS NOT NULL
             AND COALESCE(billing.checkout_claim_expires_at, 0) > unixepoch()
           )
           AND NOT (
             billing.checkout_disabled_at IS NOT NULL
             AND COALESCE(billing.checkout_disabled_expires_at, 0) > unixepoch()
           )
           AND NOT (
             billing.paid_ended_at IS NOT NULL
             AND datetime(billing.paid_ended_at) >= datetime(?)
           )
           AND datetime(COALESCE(audit.completed_at, audit.updated_at)) <
               datetime(?)
           AND COALESCE(billing.stripe_status, '') NOT IN
             ('active', 'past_due', 'trialing')
         ORDER BY COALESCE(audit.completed_at, audit.updated_at) ASC,
                  audit.id ASC
         LIMIT ?
       )
       RETURNING id`,
    )
      .bind(paidEndedAfter, retainedAfter, retentionBatchSize)
      .all<{ id: string }>();
    deleted += result.results.length;
    if (result.results.length < retentionBatchSize) return deleted;
  }
  return deleted;
}
