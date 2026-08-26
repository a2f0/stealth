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
  const failures: unknown[] = [];
  try {
    await tasks.purgeExpiredFreeAuditRuns();
  } catch (cause) {
    failures.push(cause);
  }
  const results = await Promise.allSettled([
    tasks.purgeDeletedObjects(),
    tasks.purgePendingAuditIssueImages(),
    tasks.reconcileSubscriptionSeats(),
  ]);
  for (const result of results) {
    if (result.status === "rejected") failures.push(result.reason);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Scheduled maintenance failed.");
  }
}
