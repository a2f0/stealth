import { apiUrl } from "./config";

export interface FinanceConnection {
  accountCount: number;
  createdAt: string;
  errorCode: string | null;
  id: string;
  institutionId: string | null;
  institutionName: string | null;
  lastSyncedAt: string | null;
  status: string;
}

export interface FinanceAccount {
  availableBalance: number | null;
  currencyCode: string | null;
  currentBalance: number | null;
  id: string;
  institutionName: string | null;
  mask: string | null;
  name: string;
  officialName: string | null;
  subtype: string | null;
  type: string;
}

export interface FinanceTransaction {
  accountId: string;
  accountName: string;
  amount: number;
  annotation: FinanceTransactionAnnotation;
  authorizedDate: string | null;
  categoryDetailed: string | null;
  categoryPrimary: string | null;
  currencyCode: string | null;
  id: string;
  merchantName: string | null;
  name: string;
  paymentChannel: string | null;
  pending: boolean;
  transactionDate: string;
}

export interface FinanceTransactionAnnotation {
  categoryOverride: string | null;
  labels: string[];
  note: string;
  reviewed: boolean;
}

export interface FinanceTransactionAnnotationInput {
  categoryOverride: string | null;
  labels: string[];
  note: string;
  reviewed: boolean;
}

export interface FinanceData {
  accounts: FinanceAccount[];
  configured: boolean;
  connections: FinanceConnection[];
  transactions: FinanceTransaction[];
}

export async function getFinanceData() {
  return request<FinanceData>("");
}

export async function createPlaidLinkToken() {
  return request<{ expiration: string; linkToken: string }>("/link-token", {
    method: "POST",
  });
}

export async function exchangePlaidPublicToken(
  publicToken: string,
  institution: { id: string | null; name: string | null },
) {
  return request<{ connectionId: string }>("/exchange", {
    body: JSON.stringify({
      institutionId: institution.id,
      institutionName: institution.name,
      publicToken,
    }),
    method: "POST",
  });
}

export function syncFinanceConnection(id: string) {
  return request<{ added: number; modified: number; removed: number }>(
    `/connections/${encodeURIComponent(id)}/sync`,
    { method: "POST" },
  );
}

export async function disconnectFinanceConnection(id: string) {
  const response = await fetch(
    `${apiUrl}/api/finance/connections/${encodeURIComponent(id)}`,
    { credentials: "include", method: "DELETE" },
  );
  if (!response.ok) throw await parseError(response);
}

export async function deleteFinanceConnectionData(id: string) {
  const response = await fetch(
    `${apiUrl}/api/finance/connections/${encodeURIComponent(id)}/data`,
    { credentials: "include", method: "DELETE" },
  );
  if (!response.ok) throw await parseError(response);
}

export function updateFinanceTransactionAnnotation(
  id: string,
  input: FinanceTransactionAnnotationInput,
) {
  return request<{ annotation: FinanceTransactionAnnotation }>(
    `/transactions/${encodeURIComponent(id)}/annotation`,
    { body: JSON.stringify(input), method: "PATCH" },
  );
}

async function request<T>(path: string, init?: RequestInit) {
  const requestInit: RequestInit = {
    ...init,
    credentials: "include",
  };
  if (init?.body) requestInit.headers = { "Content-Type": "application/json" };
  const response = await fetch(`${apiUrl}/api/finance${path}`, requestInit);
  if (response.ok) return response.json() as Promise<T>;
  throw await parseError(response);
}

async function parseError(response: Response) {
  const body = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  return new Error(
    body?.error ?? `Request failed with status ${response.status}.`,
  );
}
