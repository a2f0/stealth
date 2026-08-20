import { apiUrl } from "./config";
import type { OrganizationMember } from "./organizationSettingsApi";

export type OrganizationCapability = "finance";

export interface OrganizationGroup {
  capabilities: OrganizationCapability[];
  createdAt: string;
  id: string;
  memberUserIds: string[];
  name: string;
  updatedAt: string | null;
}

interface OrganizationGroupInput {
  capabilities: OrganizationCapability[];
  name: string;
  userIds: string[];
}

export function getOrganizationAccess() {
  return request<{
    capabilities: OrganizationCapability[];
    memberRole: string;
    ownerCount: number;
  }>("/access");
}

export function getOrganizationGroups() {
  return request<{
    groups: OrganizationGroup[];
    members: OrganizationMember[];
  }>("");
}

export function createOrganizationGroup(input: OrganizationGroupInput) {
  return request<{ id: string }>("", {
    body: JSON.stringify(input),
    method: "POST",
  });
}

export function updateOrganizationGroup(
  id: string,
  input: OrganizationGroupInput,
) {
  return request<{ id: string }>(`/${encodeURIComponent(id)}`, {
    body: JSON.stringify(input),
    method: "PATCH",
  });
}

export function deleteOrganizationGroup(id: string) {
  return request<void>(`/${encodeURIComponent(id)}`, { method: "DELETE" });
}

async function request<T>(path: string, init?: RequestInit) {
  const headers = init?.body ? { "Content-Type": "application/json" } : {};
  const response = await fetch(`${apiUrl}/api/organization-groups${path}`, {
    ...init,
    credentials: "include",
    headers,
  });
  if (response.ok) {
    return response.status === 204
      ? (undefined as T)
      : ((await response.json()) as T);
  }
  const body = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  throw new Error(
    body?.error ?? `Request failed with status ${response.status}.`,
  );
}
