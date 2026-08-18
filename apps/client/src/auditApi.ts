import { apiUrl } from "./config";

export type AuditResponseType = "check" | "text";
export type AuditStatus = "completed" | "in_progress";

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
  definition: AuditDefinition;
  description: string;
  id: string;
  name: string;
  status: string;
  updatedAt: string;
}

export interface AuditSummary {
  completedAt: string | null;
  createdAt: string;
  id: string;
  issueCount: number;
  responseCount: number;
  status: AuditStatus;
  templateName: string;
  updatedAt: string;
}

export interface AuditRun {
  completedAt: string | null;
  createdAt: string;
  definition: AuditDefinition;
  id: string;
  responses: Record<string, string>;
  status: AuditStatus;
  templateId: string | null;
  templateName: string;
  updatedAt: string;
}

export interface AuditIssue {
  assignedTo: string | null;
  assigneeEmail: string | null;
  assigneeName: string | null;
  createdAt: string;
  description: string;
  id: string;
  itemId: string;
  priority: string;
  status: "open" | "resolved";
  title: string;
  updatedAt: string;
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

export async function listAuditTemplates() {
  const body = await request<{ templates: AuditTemplate[] }>("/templates");
  return body.templates;
}

export async function createAuditTemplate(name: string) {
  const body = await request<{ template: AuditTemplate }>("/templates", {
    body: JSON.stringify({ name }),
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

export async function updateAuditTemplate(template: AuditTemplate) {
  return request<{ updatedAt: string }>(
    `/templates/${encodeURIComponent(template.id)}`,
    {
      body: JSON.stringify({
        definition: template.definition,
        description: template.description,
        name: template.name,
      }),
      method: "PUT",
    },
  );
}

export async function startAudit(templateId: string) {
  const body = await request<{ auditId: string }>(
    `/templates/${encodeURIComponent(templateId)}/runs`,
    { method: "POST" },
  );
  return body.auditId;
}

export async function listAuditRuns() {
  const body = await request<{ audits: AuditSummary[] }>("/runs");
  return body.audits;
}

export function getAuditRun(id: string) {
  return request<AuditDetail>(`/runs/${encodeURIComponent(id)}`);
}

export function saveAuditRun(
  id: string,
  responses: Record<string, string>,
  status: AuditStatus,
) {
  return request<{ status: AuditStatus; updatedAt: string }>(
    `/runs/${encodeURIComponent(id)}`,
    { body: JSON.stringify({ responses, status }), method: "PATCH" },
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

export function updateAuditIssue(issueId: string, status: "open" | "resolved") {
  return request<{ status: string; updatedAt: string }>(
    `/issues/${encodeURIComponent(issueId)}`,
    { body: JSON.stringify({ status }), method: "PATCH" },
  );
}

async function request<T>(path: string, init?: RequestInit) {
  const requestInit: RequestInit = {
    ...init,
    credentials: "include",
  };
  if (init?.body) requestInit.headers = { "Content-Type": "application/json" };
  const response = await fetch(`${apiUrl}/api/audits${path}`, requestInit);
  if (response.ok) return response.json() as Promise<T>;
  const body = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  throw new Error(
    body?.error ?? `Request failed with status ${response.status}.`,
  );
}
