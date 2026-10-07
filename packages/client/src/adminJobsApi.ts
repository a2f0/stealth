import { fetchApi } from "./apiVersion";
import { apiUrl } from "./config";

export interface MaintenanceJob {
  id: string;
  name: string;
  description: string;
}

export interface MaintenanceRun {
  runId: string;
  jobId: string;
  status: "succeeded" | "failed";
  durationMs: number;
  result?: unknown;
  error?: string;
}

export async function listMaintenanceJobs() {
  const response = await fetchApi(`${apiUrl}/api/admin/jobs`, {
    credentials: "include",
  });
  if (!response.ok) throw new Error("Could not load maintenance jobs.");
  const body = (await response.json()) as { jobs: MaintenanceJob[] };
  return body.jobs;
}

export async function triggerMaintenanceJob(id: string) {
  const response = await fetchApi(
    `${apiUrl}/api/admin/jobs/${encodeURIComponent(id)}/run`,
    {
      credentials: "include",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: id }),
    },
  );
  const body = (await response.json()) as {
    run?: MaintenanceRun;
    error?: string;
  };
  // Failed runs still carry a run ID for locating their logs.
  if (body.run) return body.run;
  throw new Error(body.error ?? "Could not run maintenance job.");
}
