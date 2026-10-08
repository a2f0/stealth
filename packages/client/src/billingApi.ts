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

/** Stripe's hosted Checkout page, or an inline session to embed. */
export type CheckoutSession = { url: string } | InlineCheckoutSession;

export interface InlineCheckoutSession {
  clientSecret: string;
  publishableKey: string;
}

export async function createCheckoutSession() {
  return billingPost<CheckoutSession>("checkout");
}

export async function createPortalSession() {
  return billingPost<{ url: string }>("portal");
}

export async function openCurrentBillingSession<T>(
  request: () => Promise<T>,
  isCurrent: () => boolean,
  open: (result: T) => void,
) {
  const result = await request();
  if (!isCurrent()) return false;
  open(result);
  return true;
}

async function billingPost<T>(endpoint: "checkout" | "portal") {
  const response = await fetchApi(`${apiUrl}/api/billing/${endpoint}`, {
    credentials: "include",
    method: "POST",
  });
  return parseResponse<T>(response);
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
