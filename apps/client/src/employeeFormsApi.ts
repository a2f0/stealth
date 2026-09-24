import { apiUrl } from "./config";

export type EmployeeRequirementKind =
  | "form"
  | "background_check"
  | "credit_check";
export type EmployeeRequirementStatus =
  | "pending"
  | "in_progress"
  | "submitted"
  | "complete";

export interface EmployeeRequirement {
  checkrAvailable: boolean;
  checkrPendingStart: boolean;
  checkrStarted: boolean;
  checkrInvitationStatus: string | null;
  checkrResult: string | null;
  completedAt: string | null;
  documentFilename: string | null;
  documentRevision: number;
  documentSize: number | null;
  dueDate: string;
  hasDocument: boolean;
  id: string;
  invitationId: string | null;
  invitationStatus: string | null;
  kind: EmployeeRequirementKind;
  memberId: string | null;
  status: EmployeeRequirementStatus;
  targetEmail: string | null;
  targetName: string | null;
  title: string;
}

export interface RequirementDraft {
  id: string;
  dueDate: string;
  kind: EmployeeRequirementKind;
  title: string;
}

const endpoint = `${apiUrl}/api/employee-forms`;

export class EmployeeFormsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function listEmployeeRequirements() {
  const response = await fetch(endpoint, { credentials: "include" });
  return (
    await parseResponse<{ requirements: EmployeeRequirement[] }>(response)
  ).requirements;
}

export async function createEmployeeRequirements(
  target: { invitationId: string } | { memberId: string },
  requirements: RequirementDraft[],
) {
  const response = await fetch(endpoint, {
    body: JSON.stringify({ ...target, requirements }),
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  return parseResponse<{ ids: string[] }>(response);
}

export async function updateEmployeeRequirement(
  id: string,
  update: {
    documentRevision?: number;
    dueDate?: string;
    status?: EmployeeRequirementStatus;
  },
) {
  const response = await fetch(`${endpoint}/${encodeURIComponent(id)}`, {
    body: JSON.stringify(update),
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });
  return parseResponse<{ ok: boolean }>(response);
}

export async function deleteEmployeeRequirement(id: string) {
  const response = await fetch(`${endpoint}/${encodeURIComponent(id)}`, {
    credentials: "include",
    method: "DELETE",
  });
  return parseResponse<{ ok: boolean }>(response);
}

export async function uploadEmployeeForm(id: string, file: File) {
  const body = new FormData();
  body.set("file", file);
  const response = await fetch(
    `${endpoint}/${encodeURIComponent(id)}/document`,
    {
      body,
      credentials: "include",
      method: "POST",
    },
  );
  return parseResponse<{ filename: string; status: string }>(response);
}

export async function startCheckrScreening(
  id: string,
  state: string,
  city: string,
) {
  const response = await fetch(
    `${endpoint}/${encodeURIComponent(id)}/checkr/start`,
    {
      body: JSON.stringify({ state, city }),
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  return parseResponse<{ invitationId: string; status: string }>(response);
}

export async function reconcileCheckrScreening(
  id: string,
  invitationId: string,
) {
  const response = await fetch(
    `${endpoint}/${encodeURIComponent(id)}/checkr/reconcile`,
    {
      body: JSON.stringify({ invitationId }),
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  return parseResponse<{ invitationId: string; status: string }>(response);
}

export async function refreshCheckrScreening(id: string) {
  const response = await fetch(
    `${endpoint}/${encodeURIComponent(id)}/checkr/refresh`,
    {
      credentials: "include",
      method: "POST",
    },
  );
  return parseResponse<{
    invitationStatus: string;
    reportStatus: string | null;
    result: string | null;
  }>(response);
}

export async function downloadEmployeeForm(id: string, filename: string) {
  const response = await fetch(
    `${endpoint}/${encodeURIComponent(id)}/document`,
    {
      credentials: "include",
    },
  );
  if (!response.ok) {
    await parseResponse(response);
    throw new Error("Could not download the form.");
  }
  const revision = Number(response.headers.get("X-Document-Revision"));
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("The downloaded form has no review version.");
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return revision;
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.ok) return response.json() as Promise<T>;
  const body = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  throw new EmployeeFormsApiError(
    body?.error ?? `Request failed with status ${response.status}.`,
    response.status,
  );
}
