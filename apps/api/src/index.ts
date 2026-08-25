import { app } from "./app";
import { purgePendingAuditIssueImages } from "./auditIssueImages";
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
      ]),
    );
  },
} satisfies ExportedHandler<Bindings>;
