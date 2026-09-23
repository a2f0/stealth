import { apiUrl } from "./config";

async function updateDefaultOrganization(organizationId: string) {
  const response = await fetch(
    `${apiUrl}/api/account-settings/default-organization`,
    {
      body: JSON.stringify({ organizationId }),
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? "Could not save your default organization.");
  }
}

export async function saveDefaultOrganizationPreference(
  organizationId: string,
  refreshSession: () => Promise<unknown>,
) {
  await updateDefaultOrganization(organizationId);
  await refreshSession();
}
