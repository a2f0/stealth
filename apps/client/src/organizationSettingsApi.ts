import { apiUrl } from "./config";
import type { WorkspaceOrganization } from "./organizationState";

export interface OrganizationMember {
  id: string;
  role: string;
  user: { email: string; id: string; name: string };
}

export interface OrganizationInvitation {
  email: string;
  expiresAt: string;
  id: string;
  role: string;
  status: string;
}

export interface OrganizationPeopleData {
  invitations: OrganizationInvitation[];
  memberRole: string;
  members: OrganizationMember[];
}

export async function deleteCurrentOrganization() {
  const response = await fetch(`${apiUrl}/api/organization-settings/current`, {
    credentials: "include",
    method: "DELETE",
  });
  return parseResponse<{ deletedAt: string; organizationId: string }>(response);
}

export async function getWorkspaceOrganizations() {
  const response = await fetch(
    `${apiUrl}/api/organization-settings/organizations`,
    { credentials: "include" },
  );
  const body = await parseResponse<{
    organizations: WorkspaceOrganization[];
  }>(response);
  return body.organizations;
}

export async function getOrganizationPeople() {
  const response = await fetch(`${apiUrl}/api/organization-settings/people`, {
    credentials: "include",
  });
  return parseResponse<OrganizationPeopleData>(response);
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.ok) return response.json() as Promise<T>;
  const body = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  throw new Error(
    body?.error ?? `Request failed with status ${response.status}.`,
  );
}
