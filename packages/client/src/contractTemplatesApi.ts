import { fetchApi } from "./apiVersion";
import { apiUrl } from "./config";
import type { DraftField, DraftInput } from "./contractsApi";

export interface TemplateRole {
  key: string;
  label: string;
  routingOrder: number;
}

export interface TemplateDefinition {
  fields: Array<Omit<DraftField, "key" | "recipientKey"> & { roleKey: string }>;
  message: string;
  reminderIntervalDays: number | null;
  roles: TemplateRole[];
  signingOrder: DraftInput["signingOrder"];
}

export interface ContractTemplateSummary {
  currentVersion: number;
  description: string;
  id: string;
  name: string;
  updatedAt: string;
}

export interface ContractTemplate {
  createdAt: string;
  createdByName: string | null;
  currentVersion: number;
  definition: TemplateDefinition;
  description: string;
  document: {
    filename: string;
    pageCount: number;
    sha256: string;
    size: number;
  };
  id: string;
  name: string;
  version: number;
}

export interface TemplateVersion {
  createdAt: string;
  createdByName: string | null;
  name: string;
  version: number;
}

const root = `${apiUrl}/api/contracts/templates`;

export async function listContractTemplates() {
  return (await request<{ templates: ContractTemplateSummary[] }>(""))
    .templates;
}

export async function uploadContractTemplate(file: File) {
  const body = new FormData();
  body.set("file", file);
  return (
    await request<{ template: ContractTemplate }>("", { body, method: "POST" })
  ).template;
}

export async function getContractTemplate(id: string, version?: number) {
  const suffix = version === undefined ? "" : `?version=${version}`;
  return (await request<{ template: ContractTemplate }>(`${path(id)}${suffix}`))
    .template;
}

export async function listTemplateVersions(id: string) {
  return (
    await request<{ versions: TemplateVersion[] }>(`${path(id)}/versions`)
  ).versions;
}

export async function saveTemplateVersion(
  template: ContractTemplate,
  input: { name: string; description: string; definition: TemplateDefinition },
) {
  return (
    await request<{ template: ContractTemplate }>(
      `${path(template.id)}/versions`,
      {
        body: JSON.stringify({
          ...input,
          expectedCurrentVersion: template.currentVersion,
          sourceVersion: template.version,
        }),
        method: "POST",
      },
    )
  ).template;
}

export async function createContractFromTemplate(
  id: string,
  input: {
    dueDate: string | null;
    recipients: Array<{ roleKey: string; name: string; email: string }>;
    title: string;
    version: number;
  },
) {
  return (
    await request<{ contractId: string }>(`${path(id)}/contracts`, {
      body: JSON.stringify(input),
      method: "POST",
    })
  ).contractId;
}

export function deleteContractTemplate(id: string) {
  return request<void>(path(id), { method: "DELETE" });
}

export async function loadTemplateDocument(id: string, version: number) {
  const response = await fetchApi(
    `${root}${path(id)}/document?version=${version}`,
    { credentials: "include" },
  );
  if (!response.ok)
    throw new Error("The template document could not be loaded.");
  return response.arrayBuffer();
}

function path(id: string) {
  return `/${encodeURIComponent(id)}`;
}

async function request<T>(route: string, init?: RequestInit): Promise<T> {
  const response = await fetchApi(`${root}${route}`, {
    ...init,
    credentials: "include",
    ...(typeof init?.body === "string"
      ? { headers: { "Content-Type": "application/json" } }
      : {}),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? "The template request failed.");
  }
  return response.status === 204
    ? (undefined as T)
    : (response.json() as Promise<T>);
}
