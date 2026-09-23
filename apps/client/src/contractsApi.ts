import { apiUrl } from "./config";

export type ContractStatus =
  | "completed"
  | "declined"
  | "draft"
  | "sent"
  | "voided";
export type FieldType =
  | "date_signed"
  | "initials"
  | "name"
  | "signature"
  | "text";
export type RecipientStatus =
  | "declined"
  | "pending"
  | "sent"
  | "signed"
  | "viewed";

export interface ContractSummary {
  completedAt: string | null;
  createdAt: string;
  dueDate: string | null;
  id: string;
  senderName: string | null;
  sentAt: string | null;
  signedCount: number;
  signerCount: number;
  status: ContractStatus;
  title: string;
  updatedAt: string;
}

export interface ContractRecipient {
  declineReason: string | null;
  declinedAt: string | null;
  email: string;
  id: string;
  lastRemindedAt: string | null;
  name: string;
  notifiedAt: string | null;
  routingOrder: number;
  signedAt: string | null;
  status: RecipientStatus;
  viewedAt: string | null;
}

export interface FieldBox {
  height: number;
  page: number;
  width: number;
  x: number;
  y: number;
}

export interface ContractField extends FieldBox {
  id: string;
  label: string | null;
  recipientId: string;
  required: boolean;
  type: FieldType;
  value: string | null;
}

export interface ContractEvent {
  actorName: string | null;
  createdAt: string;
  detail: string | null;
  id: string;
  ip: string | null;
  recipientId: string | null;
  type: string;
}

export interface ContractDetail {
  completedAt: string | null;
  createdAt: string;
  createdByName: string | null;
  document: {
    filename: string;
    pageCount: number;
    sha256: string;
    size: number;
  };
  dueDate: string | null;
  events: ContractEvent[];
  fields: ContractField[];
  finalSha256: string | null;
  id: string;
  message: string;
  recipients: ContractRecipient[];
  reminderIntervalDays: number | null;
  sentAt: string | null;
  sentByName: string | null;
  signingOrder: "parallel" | "sequential";
  status: ContractStatus;
  title: string;
  updatedAt: string;
  voidReason: string | null;
  voidedAt: string | null;
}

export interface DraftRecipient {
  email: string;
  key: string;
  name: string;
  routingOrder: number;
}

export interface DraftField extends FieldBox {
  key: string;
  label: string | null;
  recipientKey: string;
  required: boolean;
  type: FieldType;
}

export interface DraftInput {
  dueDate: string | null;
  fields: DraftField[];
  message: string;
  recipients: DraftRecipient[];
  reminderIntervalDays: number | null;
  signingOrder: "parallel" | "sequential";
  title: string;
}

export async function listContracts() {
  const body = await request<{ contracts: ContractSummary[] }>("");
  return body.contracts;
}

export async function uploadContract(file: File) {
  const form = new FormData();
  form.set("file", file);
  const response = await fetch(`${apiUrl}/api/contracts`, {
    body: form,
    credentials: "include",
    method: "POST",
  });
  if (!response.ok) throw await parseError(response);
  const body = (await response.json()) as { contract: ContractDetail };
  return body.contract;
}

export async function getContract(id: string) {
  const body = await request<{ contract: ContractDetail }>(path(id));
  return body.contract;
}

export async function saveContractDraft(id: string, draft: DraftInput) {
  const body = await request<{ contract: ContractDetail }>(
    `${path(id)}/draft`,
    { body: JSON.stringify(draft), method: "PUT" },
  );
  return body.contract;
}

export async function sendContract(id: string) {
  const body = await request<{ contract: ContractDetail }>(`${path(id)}/send`, {
    method: "POST",
  });
  return body.contract;
}

export function remindContract(id: string) {
  return request<{ contract: ContractDetail; reminded: number }>(
    `${path(id)}/remind`,
    { method: "POST" },
  );
}

export async function voidContract(id: string, reason: string) {
  const body = await request<{ contract: ContractDetail }>(`${path(id)}/void`, {
    body: JSON.stringify({ reason }),
    method: "POST",
  });
  return body.contract;
}

export async function deleteContract(id: string) {
  const response = await fetch(`${apiUrl}/api/contracts${path(id)}`, {
    credentials: "include",
    method: "DELETE",
  });
  if (!response.ok) throw await parseError(response);
}

export function contractDocumentUrl(id: string) {
  return `${apiUrl}/api/contracts${path(id)}/document`;
}

export function contractFinalUrl(id: string) {
  return `${apiUrl}/api/contracts${path(id)}/final`;
}

function path(id: string) {
  return `/${encodeURIComponent(id)}`;
}

async function request<T>(route: string, init?: RequestInit) {
  const requestInit: RequestInit = { ...init, credentials: "include" };
  if (init?.body) requestInit.headers = { "Content-Type": "application/json" };
  const response = await fetch(`${apiUrl}/api/contracts${route}`, requestInit);
  if (response.ok) return response.json() as Promise<T>;
  throw await parseError(response);
}

async function parseError(response: Response) {
  const body = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  return new Error(
    body?.error ?? `Request failed with status ${response.status}.`,
  );
}
