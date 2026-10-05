import { apiUrl } from "./config";

export interface Business {
  city: string | null;
  createdAt: string;
  duns: string | null;
  ein: string | null;
  id: string;
  incorporationDate: string | null;
  name: string;
  state: string | null;
  streetAddress: string | null;
  updatedAt: string;
  zip: string | null;
}

export interface BusinessInput {
  city?: string | null;
  duns?: string | null;
  ein?: string | null;
  incorporationDate?: string | null;
  name: string;
  state?: string | null;
  streetAddress?: string | null;
  zip?: string | null;
}

export interface BusinessListing {
  businesses: Business[];
  canManage: boolean;
}

export function getBusinesses() {
  return request<BusinessListing>("");
}

export function getBusiness(id: string) {
  return request<{ business: Business }>(`/${encodeURIComponent(id)}`);
}

export function createBusiness(input: BusinessInput) {
  return request<{ business: Business }>("", {
    body: JSON.stringify(input),
    method: "POST",
  });
}

export function updateBusiness(id: string, input: BusinessInput) {
  return request<{ business: Business }>(`/${encodeURIComponent(id)}`, {
    body: JSON.stringify(input),
    method: "PATCH",
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
