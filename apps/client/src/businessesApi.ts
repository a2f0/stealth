import { apiUrl } from "./config";

export interface Business {
  createdAt: string;
  ein: string;
  id: string;
  name: string;
  updatedAt: string;
}

export interface BusinessListing {
  businesses: Business[];
  canManage: boolean;
}

export function getBusinesses() {
  return request<BusinessListing>("");
}

export function createBusiness(input: { ein: string; name: string }) {
  return request<{ business: Business }>("", {
    body: JSON.stringify(input),
    method: "POST",
  });
}

export function deleteBusiness(id: string) {
  return request<void>(`/${encodeURIComponent(id)}`, { method: "DELETE" });
}

async function request<T>(path: string, init?: RequestInit) {
  const headers = init?.body ? { "Content-Type": "application/json" } : {};
  const response = await fetch(`${apiUrl}/api/businesses${path}`, {
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
