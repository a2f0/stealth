import type { ActivityActor } from "./activityApi";
import { fetchApi } from "./apiVersion";
import { apiUrl } from "./config";

type AuditResponseType = "check" | "text";
export type AuditStatus = "completed" | "in_progress";
export type AuditTemplateScope = "global" | "organization";

export interface AuditTemplateItem {
  id: string;
  prompt: string;
  required: boolean;
  responseType: AuditResponseType;
}

export interface AuditTemplateSection {
  id: string;
  items: AuditTemplateItem[];
  title: string;
}

export interface AuditDefinition {
  sections: AuditTemplateSection[];
  version: 1;
}

export interface AuditTemplate {
  createdAt: string;
  currentVersion: number;
  definition: AuditDefinition;
  description: string;
  id: string;
  name: string;
  savedAt: string;
  savedBy: AuditTemplateVersionActor;
  scope: AuditTemplateScope;
  status: string;
  updatedAt: string;
  version: number;
}

type AuditTemplateVersionActor = ActivityActor;

export interface AuditTemplateVersion {
  createdAt: string;
  createdBy: AuditTemplateVersionActor;
  version: number;
}

export interface AuditSummary {
  completedAt: string | null;
  createdAt: string;
  createdBy: ActivityActor;
  id: string;
  issueCount: number;
  responseCount: number;
  status: AuditStatus;
  templateName: string;
  templateVersion: number | null;
  updatedAt: string;
}

interface AuditRunPage {
  audits: AuditSummary[];
  nextCursor: string | null;
}

export interface AuditRun {
  answerActivity: Record<string, { actor: ActivityActor; occurredAt: string }>;
  completedAt: string | null;
  createdAt: string;
  createdBy: ActivityActor;
  definition: AuditDefinition;
  id: string;
  responses: Record<string, string>;
  revision: number;
  status: AuditStatus;
  templateId: string | null;
  templateName: string;
  templateVersion: number | null;
  updatedAt: string;
}

export interface AuditIssue {
  assignedTo: string | null;
  assigneeEmail: string | null;
  assigneeName: string | null;
  createdAt: string;
  createdBy: ActivityActor;
  description: string;
  id: string;
  images: AuditIssueImage[];
  itemId: string;
  priority: string;
  status: "open" | "resolved";
  title: string;
  updatedAt: string;
}

export interface AuditIssueImage {
  contentType: string;
  createdAt: string;
  filename: string;
  id: string;
  size: number;
  uploadedBy: AuditTemplateVersionActor;
}

export interface OrganizationMember {
  email: string;
  id: string;
  name: string;
}

export interface AuditDetail {
  audit: AuditRun;
  issues: AuditIssue[];
  members: OrganizationMember[];
}

export class AuditApiError extends Error {
  readonly response: Response;

  constructor(message: string, response: Response) {
    super(message);
    this.name = "AuditApiError";
    this.response = response;
  }
}

export async function listAuditTemplates() {
  const body = await request<{ templates: AuditTemplate[] }>("/templates");
  return body.templates;
}

export async function createAuditTemplate(
  name: string,
  scope: AuditTemplateScope,
) {
  const body = await request<{ template: AuditTemplate }>("/templates", {
    body: JSON.stringify({ name, scope }),
    method: "POST",
  });
  return body.template;
}

export async function getAuditTemplate(id: string) {
  const body = await request<{ template: AuditTemplate }>(
    `/templates/${encodeURIComponent(id)}`,
  );
  return body.template;
}

export async function getAuditTemplateVersion(id: string, version: number) {
  const body = await request<{ template: AuditTemplate }>(
    `/templates/${encodeURIComponent(id)}/versions/${version}`,
  );
  return body.template;
}

export async function listAuditTemplateVersions(id: string) {
  const body = await request<{ versions: AuditTemplateVersion[] }>(
    `/templates/${encodeURIComponent(id)}/versions`,
  );
  return body.versions;
}

export async function updateAuditTemplate(template: AuditTemplate) {
  const body = await request<{ template: AuditTemplate }>(
    `/templates/${encodeURIComponent(template.id)}`,
    {
      body: templateSaveBody(template),
      method: "PUT",
    },
  );
  return body.template;
}

export async function copyAuditTemplate(template: AuditTemplate) {
  const body = await request<{ template: AuditTemplate }>(
    `/templates/${encodeURIComponent(template.id)}/copies`,
    {
      body: templateSaveBody(template),
      method: "POST",
    },
  );
  return body.template;
}

export async function startAudit(templateId: string) {
  const body = await request<{ auditId: string }>(
    `/templates/${encodeURIComponent(templateId)}/runs`,
    { method: "POST" },
  );
  return body.auditId;
}

export function listAuditRuns(cursor?: string) {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return request<AuditRunPage>(`/runs${query}`);
}

export function getAuditRun(id: string) {
  return request<AuditDetail>(`/runs/${encodeURIComponent(id)}`);
}

export function saveAuditRun(
  id: string,
  responses: Record<string, string>,
  status: AuditStatus,
  expectedRevision: number,
) {
  return request<{ status: AuditStatus; updatedAt: string }>(
    `/runs/${encodeURIComponent(id)}`,
    {
      body: JSON.stringify({ expectedRevision, responses, status }),
      method: "PATCH",
    },
  );
}

export function createAuditIssue(
  auditId: string,
  issue: {
    assignedTo: string | null;
    description: string;
    itemId: string;
    priority: string;
    title: string;
  },
) {
  return request<{ issueId: string }>(
    `/runs/${encodeURIComponent(auditId)}/issues`,
    { body: JSON.stringify(issue), method: "POST" },
  );
}

export function updateAuditIssue(
  issueId: string,
  update: { assignedTo?: string | null; status?: "open" | "resolved" },
) {
  return request<{
    assignedTo: string | null;
    status: string;
    updatedAt: string;
  }>(`/issues/${encodeURIComponent(issueId)}`, {
    body: JSON.stringify(update),
    method: "PATCH",
  });
}

export function uploadAuditIssueImage(issueId: string, file: File) {
  return request<{ image: AuditIssueImage }>(
    `/issues/${encodeURIComponent(issueId)}/images?filename=${encodeURIComponent(file.name)}`,
    {
      body: file,
      headers: { "Content-Type": file.type || "application/octet-stream" },
      method: "POST",
    },
  );
}

export function deleteAuditIssueImage(issueId: string, imageId: string) {
  return request<void>(
    `/issues/${encodeURIComponent(issueId)}/images/${encodeURIComponent(imageId)}`,
    { method: "DELETE" },
  );
}

export function auditIssueImageUrl(
  issueId: string,
  imageId: string,
  variant?: "thumbnail",
) {
  const query = variant === "thumbnail" ? "?variant=thumbnail" : "";
  return `${apiUrl}/api/audits/issues/${encodeURIComponent(issueId)}/images/${encodeURIComponent(imageId)}${query}`;
}

function templateSaveBody(template: AuditTemplate) {
  return JSON.stringify({
    definition: template.definition,
    description: template.description,
    expectedCurrentVersion: template.currentVersion,
    name: template.name,
  });
}

async function request<T>(path: string, init?: RequestInit) {
  const requestInit: RequestInit = {
    ...init,
    credentials: "include",
  };
  if (init?.body && !(init.body instanceof FormData) && !init.headers) {
    requestInit.headers = { "Content-Type": "application/json" };
  }
  const response = await fetchApi(`${apiUrl}/api/audits${path}`, requestInit);
  if (response.ok) {
    return response.status === 204
      ? (undefined as T)
      : (response.json() as Promise<T>);
  }
  const body = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  throw new AuditApiError(
    body?.error ?? `Request failed with status ${response.status}.`,
    response,
  );
}
