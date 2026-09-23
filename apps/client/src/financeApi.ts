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
  /** The transaction's single expense category, if one is assigned. */
  expenseCategoryId: string | null;
  id: string;
  merchantName: string | null;
  name: string;
  paymentChannel: string | null;
  pending: boolean;
  transactionDate: string;
}

export interface FinanceTransactionAnnotation {
  labels: string[];
  note: string;
  reviewed: boolean;
}

export interface FinanceTransactionAnnotationInput {
  labels: string[];
  note: string;
  reviewed: boolean;
}

export interface ExpenseCategory {
  id: string;
  name: string;
  transactionCount: number;
}

export interface ExpenseCategoryTotal {
  /** Null for the uncategorized bucket. */
  id: string | null;
  name: string;
  total: number;
  transactionCount: number;
}

export interface ExpenseReportCurrency {
  categories: ExpenseCategoryTotal[];
  currency: string;
  excludedTransfers: { total: number; transactionCount: number };
  total: number;
  transactionCount: number;
}

export interface ExpenseReport {
  currencies: ExpenseReportCurrency[];
  from: string | null;
  to: string | null;
}

export interface FinanceData {
  accounts: FinanceAccount[];
  categories: ExpenseCategory[];
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

export function setTransactionCategory(id: string, categoryId: string | null) {
  return request<{ expenseCategoryId: string | null }>(
    `/transactions/${encodeURIComponent(id)}/category`,
    { body: JSON.stringify({ categoryId }), method: "PUT" },
  );
}

export function createExpenseCategory(name: string) {
  return request<{ category: ExpenseCategory }>("/categories", {
    body: JSON.stringify({ name }),
    method: "POST",
  });
}

export function renameExpenseCategory(id: string, name: string) {
  return request<{ category: { id: string; name: string } }>(
    `/categories/${encodeURIComponent(id)}`,
    { body: JSON.stringify({ name }), method: "PATCH" },
  );
}

export async function deleteExpenseCategory(id: string) {
  const response = await fetch(
    `${apiUrl}/api/finance/categories/${encodeURIComponent(id)}`,
    { credentials: "include", method: "DELETE" },
  );
  if (!response.ok) throw await parseError(response);
}

export function addDefaultExpenseCategories() {
  return request<{ categories: ExpenseCategory[] }>("/categories/defaults", {
    method: "POST",
  });
}

export function getExpenseReport(range: {
  from: string | null;
  to: string | null;
}) {
  const query = new URLSearchParams();
  if (range.from) query.set("from", range.from);
  if (range.to) query.set("to", range.to);
  const search = query.size ? `?${query}` : "";
  return request<ExpenseReport>(`/reports/expenses${search}`);
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
