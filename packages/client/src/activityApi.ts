import { fetchApi } from "./apiVersion";
import { apiUrl } from "./config";

export interface ActivityActor {
  email: string;
  id: string;
  name: string;
}

export interface ActivityEvent {
  action: string;
  actor: ActivityActor;
  details: ActivityDetails;
  historical: boolean;
  id: number;
  occurredAt: string;
  root: { id: string; label: string; type: string };
  subject: { id: string; type: string };
}

interface ActivityDetails {
  after?: unknown;
  afterEmail?: unknown;
  afterName?: unknown;
  assignedTo?: unknown;
  assigneeEmail?: unknown;
  assigneeName?: unknown;
  before?: unknown;
  beforeEmail?: unknown;
  beforeName?: unknown;
  description?: unknown;
  filename?: unknown;
  priority?: unknown;
  prompt?: unknown;
  responseType?: unknown;
  title?: unknown;
  version?: unknown;
  [key: string]: unknown;
}

export interface ActivityPage {
  events: ActivityEvent[];
  nextCursor: string | null;
}

export type ActivitySource =
  | {
      id: string;
      type: "audit_run" | "audit_template" | "global_audit_template";
    }
  | undefined;

export async function listActivity(source?: ActivitySource, cursor?: string) {
  const base = activityPath(source);
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const response = await fetchApi(`${apiUrl}${base}${query}`, {
    credentials: "include",
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? "Could not load activity.");
  }
  return response.json() as Promise<ActivityPage>;
}

/** A global form's history is read through Global Audits, when managing it. */
function activityPath(source: ActivitySource) {
  if (!source) return "/api/activity";
  const id = encodeURIComponent(source.id);
  if (source.type === "audit_run") return `/api/audits/runs/${id}/activity`;
  if (source.type === "global_audit_template") {
    return `/api/admin/audit-templates/${id}/activity`;
  }
  return `/api/audits/templates/${id}/activity`;
}
