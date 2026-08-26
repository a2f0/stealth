import { freeRetentionDays } from "./billing";
import type { Bindings } from "./types";

const retentionBatchSize = 100;

/** Permanently remove audit history outside a free organization's window. */
export async function purgeExpiredFreeAuditRuns(
  environment: Pick<Bindings, "DB" | "STRIPE_PRO_PRICE_ID">,
  retainedAfter = new Date(
    Date.now() - freeRetentionDays * 24 * 60 * 60 * 1_000,
  ).toISOString(),
) {
  let deleted = 0;
  while (true) {
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
           AND datetime(audit.created_at) < datetime(?)
           AND NOT (
             COALESCE(billing.stripe_price_id, '') = ?
             AND COALESCE(billing.stripe_status, '') IN
               ('active', 'past_due', 'trialing')
           )
         ORDER BY audit.created_at ASC, audit.id ASC
         LIMIT ?
       )
       RETURNING id`,
    )
      .bind(
        retainedAfter,
        environment.STRIPE_PRO_PRICE_ID ?? "",
        retentionBatchSize,
      )
      .all<{ id: string }>();
    deleted += result.results.length;
    if (result.results.length < retentionBatchSize) return deleted;
  }
}
