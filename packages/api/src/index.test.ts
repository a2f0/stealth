import { expect, it } from "bun:test";
import { runScheduledMaintenance } from "./maintenance";

it("tombstones expired audit images before scheduled cleanup", async () => {
  const events: string[] = [];
  let releaseRetention: () => void = () => undefined;
  const retentionFinished = new Promise<void>((resolve) => {
    releaseRetention = resolve;
  });
  const maintenance = runScheduledMaintenance({
    purgeRequestedUsers: async () => events.push("users"),
    purgeDeletedObjects: async () => events.push("deleted objects"),
    purgeExpiredFreeAuditRuns: async () => {
      events.push("retention started");
      await retentionFinished;
      events.push("retention finished");
    },
    purgePendingAuditIssueImages: async () => events.push("issue images"),
    purgeStripeWebhookReceipts: async () => events.push("webhook receipts"),
    reconcileSubscriptionSeats: async () => events.push("seats"),
    maintainContracts: async () => events.push("contracts"),
    refreshCheckrScreenings: async () => events.push("checkr screenings"),
  });

  await Promise.resolve();
  expect(events).toEqual(["retention started"]);
  releaseRetention();
  await maintenance;
  expect(events).toEqual([
    "retention started",
    "retention finished",
    "users",
    "deleted objects",
    "issue images",
    "webhook receipts",
    "seats",
    "contracts",
    "checkr screenings",
  ]);
});

it("runs independent maintenance after retention fails", async () => {
  const events: string[] = [];
  const retentionFailure = new Error("retention failed");
  const maintenance = runScheduledMaintenance({
    purgeRequestedUsers: async () => events.push("users"),
    purgeDeletedObjects: async () => events.push("deleted objects"),
    purgeExpiredFreeAuditRuns: async () => {
      events.push("retention");
      throw retentionFailure;
    },
    purgePendingAuditIssueImages: async () => events.push("issue images"),
    purgeStripeWebhookReceipts: async () => events.push("webhook receipts"),
    reconcileSubscriptionSeats: async () => events.push("seats"),
    maintainContracts: async () => events.push("contracts"),
    refreshCheckrScreenings: async () => events.push("checkr screenings"),
  });

  await expect(maintenance).rejects.toThrow("Scheduled maintenance failed.");
  expect(events).toEqual([
    "retention",
    "users",
    "deleted objects",
    "issue images",
    "webhook receipts",
    "seats",
    "contracts",
    "checkr screenings",
  ]);
});
