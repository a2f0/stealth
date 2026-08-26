import { expect, it } from "bun:test";
import { runScheduledMaintenance } from "./index";

it("tombstones expired audit images before scheduled cleanup", async () => {
  const events: string[] = [];
  let releaseRetention: () => void = () => undefined;
  const retentionFinished = new Promise<void>((resolve) => {
    releaseRetention = resolve;
  });
  const maintenance = runScheduledMaintenance({
    purgeDeletedObjects: async () => events.push("deleted objects"),
    purgeExpiredFreeAuditRuns: async () => {
      events.push("retention started");
      await retentionFinished;
      events.push("retention finished");
    },
    purgePendingAuditIssueImages: async () => events.push("issue images"),
    reconcileSubscriptionSeats: async () => events.push("seats"),
  });

  await Promise.resolve();
  expect(events).toEqual(["retention started"]);
  releaseRetention();
  await maintenance;
  expect(events).toEqual([
    "retention started",
    "retention finished",
    "deleted objects",
    "issue images",
    "seats",
  ]);
});
