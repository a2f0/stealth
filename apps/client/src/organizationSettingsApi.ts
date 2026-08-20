import { apiUrl } from "./config";

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

export async function getOrganizationPeople() {
  const response = await fetch(`${apiUrl}/api/organization-settings/people`, {
    credentials: "include",
  });
  if (response.ok) return response.json() as Promise<OrganizationPeopleData>;
  const body = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  throw new Error(
    body?.error ?? `Request failed with status ${response.status}.`,
  );
}
