import { purgePendingAuditIssueImages } from "./auditIssueImages";
import {
  purgeStripeWebhookReceipts,
  reconcileSubscriptionSeats,
} from "./billing";
import { purgeExpiredFreeAuditRuns } from "./billingRetention";
import { refreshActiveCheckrScreenings } from "./checkrSync";
import { maintainContracts } from "./contractReminders";
import { purgeDeletedObjects } from "./deletedObjectCleanup";
import type { Bindings } from "./types";
import { purgeRequestedUsers } from "./userDeletion";

export const maintenanceJobs = [
  {
    id: "purgeRequestedUsers",
    name: "Purge requested user accounts",
    description:
      "Permanently deletes accounts requested for deletion at least 30 days ago. Skips admins, active organization members, and accounts required by retained audit, financial, or contract records.",
  },
  {
    id: "purgeExpiredFreeAuditRuns",
    name: "Purge expired Free audit history",
    description:
      "Permanently deletes audit runs that meet the existing Free-plan retention policy. Organizations whose paid plan ended keep their history for a 30-day grace period first.",
  },
  {
    id: "purgeDeletedObjects",
    name: "Purge deleted files",
    description:
      "Deletes a batch of queued files from storage after their upload grace period.",
  },
  {
    id: "purgePendingAuditIssueImages",
    name: "Purge abandoned audit images",
    description: "Removes expired, unfinished audit image uploads.",
  },
  {
    id: "purgeStripeWebhookReceipts",
    name: "Purge old billing receipts",
    description: "Deletes Stripe webhook receipts past their retention period.",
  },
  {
    id: "reconcileSubscriptionSeats",
    name: "Reconcile subscription seats",
    description:
      "Synchronizes seat quantities with Stripe. May change billing quantities.",
  },
  {
    id: "maintainContracts",
    name: "Maintain contracts",
    description:
      "Sends due reminder emails and resumes stalled signing workflows.",
  },
  {
    id: "refreshCheckrScreenings",
    name: "Refresh Checkr screenings",
    description:
      "Re-reads unfinished Checkr screenings in case a webhook was missed.",
  },
] as const;

type MaintenanceJobId = (typeof maintenanceJobs)[number]["id"];
type MaintenanceTasks = Record<MaintenanceJobId, () => Promise<unknown>>;

type RunSource =
  | { trigger: "manual"; actorUserId: string }
  | { trigger: "scheduled"; cron: string; scheduledTime: number };

export function maintenanceTasks(environment: Bindings): MaintenanceTasks {
  return {
    purgeRequestedUsers: () => purgeRequestedUsers(environment),
    purgeDeletedObjects: () => purgeDeletedObjects(environment),
    purgeExpiredFreeAuditRuns: () => purgeExpiredFreeAuditRuns(environment),
    purgePendingAuditIssueImages: () =>
      purgePendingAuditIssueImages(environment),
    purgeStripeWebhookReceipts: () => purgeStripeWebhookReceipts(environment),
    reconcileSubscriptionSeats: () => reconcileSubscriptionSeats(environment),
    maintainContracts: () => maintainContracts(environment),
    refreshCheckrScreenings: () => refreshActiveCheckrScreenings(environment),
  };
}

export async function runMaintenanceJob(
  jobId: MaintenanceJobId,
  task: () => Promise<unknown>,
  source: RunSource,
) {
  const started = Date.now();
  const details = {
    event: "maintenance_job",
    runId: crypto.randomUUID(),
    jobId,
    ...source,
    startedAt: new Date(started).toISOString(),
  };
  console.log({ ...details, status: "running" });
  try {
    const result = await task();
    const run = {
      ...details,
      status: "succeeded" as const,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      result: result ?? null,
    };
    console.log(run);
    return run;
  } catch (cause) {
    const run = {
      ...details,
      status: "failed" as const,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      error:
        "Job failed; some work may have completed. Check Workers Logs before retrying.",
    };
    console.error(run, cause);
    return run;
  }
}

export async function runScheduledMaintenance(
  tasks: MaintenanceTasks,
  source: Extract<RunSource, { trigger: "scheduled" }> = {
    trigger: "scheduled",
    cron: "17 * * * *",
    scheduledTime: Date.now(),
  },
) {
  // Retention queues deleted image objects before object cleanup runs.
  const retention = await runMaintenanceJob(
    "purgeExpiredFreeAuditRuns",
    tasks.purgeExpiredFreeAuditRuns,
    source,
  );
  const results = await Promise.all(
    maintenanceJobs
      .filter(({ id }) => id !== "purgeExpiredFreeAuditRuns")
      .map(({ id }) => runMaintenanceJob(id, tasks[id], source)),
  );
  const failures = [retention, ...results].filter(
    (run) => run.status === "failed",
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "Scheduled maintenance failed.");
  }
}
