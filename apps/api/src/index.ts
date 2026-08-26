import { app } from "./app";
import { purgePendingAuditIssueImages } from "./auditIssueImages";
import { reconcileSubscriptionSeats } from "./billing";
import { purgeExpiredFreeAuditRuns } from "./billingRetention";
import { purgeDeletedObjects } from "./deletedObjectCleanup";
import { handleEmail } from "./email";
import type { Bindings } from "./types";

export default {
  email: handleEmail,
  fetch: app.fetch,
  scheduled: (_controller, environment, context) => {
    context.waitUntil(
      runScheduledMaintenance({
        purgeDeletedObjects: () => purgeDeletedObjects(environment),
        purgeExpiredFreeAuditRuns: () => purgeExpiredFreeAuditRuns(environment),
        purgePendingAuditIssueImages: () =>
          purgePendingAuditIssueImages(environment),
        reconcileSubscriptionSeats: () =>
          reconcileSubscriptionSeats(environment),
      }),
    );
  },
} satisfies ExportedHandler<Bindings>;

interface ScheduledMaintenanceTasks {
  purgeDeletedObjects: () => Promise<unknown>;
  purgeExpiredFreeAuditRuns: () => Promise<unknown>;
  purgePendingAuditIssueImages: () => Promise<unknown>;
  reconcileSubscriptionSeats: () => Promise<unknown>;
}

export async function runScheduledMaintenance(
  tasks: ScheduledMaintenanceTasks,
) {
  await tasks.purgeExpiredFreeAuditRuns();
  await Promise.all([
    tasks.purgeDeletedObjects(),
    tasks.purgePendingAuditIssueImages(),
    tasks.reconcileSubscriptionSeats(),
  ]);
}
