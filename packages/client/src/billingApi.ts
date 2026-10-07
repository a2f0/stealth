import { fetchApi } from "./apiVersion";
import { apiUrl } from "./config";

export interface BillingStatus {
  billing: {
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: string | null;
    status: string | null;
  };
  canManage: boolean;
  current: { formTemplates: number; members: number };
  limits: {
    formTemplates: number | null;
    retentionDays: number | null;
    users: number | null;
  };
  plan: "free" | "pro";
  pricing: { currency: "usd"; proMonthlyPerSeat: number };
  seats: number;
}

export async function getBillingStatus(sessionId?: string) {
  const query = sessionId
    ? `?${new URLSearchParams({ session_id: sessionId })}`
    : "";
  const response = await fetchApi(`${apiUrl}/api/billing${query}`, {
    credentials: "include",
  });
  return parseResponse<BillingStatus>(response);
}

export async function createCheckoutSession() {
  return billingRedirect("checkout");
}

export async function createPortalSession() {
  return billingRedirect("portal");
}

export async function redirectToCurrentBillingSession(
  request: () => Promise<{ url: string }>,
  isCurrent: () => boolean,
  navigate: (url: string) => void,
) {
  const result = await request();
  if (!isCurrent()) return false;
  navigate(result.url);
  return true;
}

async function billingRedirect(endpoint: "checkout" | "portal") {
  const response = await fetchApi(`${apiUrl}/api/billing/${endpoint}`, {
    credentials: "include",
    method: "POST",
  });
  return parseResponse<{ url: string }>(response);
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
