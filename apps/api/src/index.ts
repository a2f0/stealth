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
      Promise.all([
        purgeDeletedObjects(environment),
        purgePendingAuditIssueImages(environment),
        purgeExpiredFreeAuditRuns(environment),
        reconcileSubscriptionSeats(environment),
      ]),
    );
  },
} satisfies ExportedHandler<Bindings>;
