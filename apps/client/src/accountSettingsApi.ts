import { apiUrl } from "./config";

export async function updateDefaultOrganization(organizationId: string) {
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
