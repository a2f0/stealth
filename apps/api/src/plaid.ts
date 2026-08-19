import type { Bindings } from "./types";

export interface PlaidAccount {
  account_id: string;
  balances: {
    available: number | null;
    current: number | null;
    iso_currency_code: string | null;
    unofficial_currency_code: string | null;
  };
  mask: string | null;
  name: string;
  official_name: string | null;
  subtype: string | null;
  type: string;
}

export interface PlaidTransaction {
  account_id: string;
  amount: number;
  authorized_date: string | null;
  date: string;
  iso_currency_code: string | null;
  merchant_name: string | null;
  name: string;
  payment_channel: string | null;
  pending: boolean;
  pending_transaction_id: string | null;
  personal_finance_category: {
    detailed: string;
    primary: string;
  } | null;
  transaction_id: string;
  unofficial_currency_code: string | null;
}

export interface TransactionsSyncResponse {
  accounts: PlaidAccount[];
  added: PlaidTransaction[];
  has_more: boolean;
  modified: PlaidTransaction[];
  next_cursor: string;
  removed: Array<{ transaction_id: string }>;
}

export interface PlaidRequestBody extends Record<string, unknown> {
  access_token?: unknown;
  public_token?: unknown;
  transactions?: unknown;
}

export type PlaidRequest = <T>(
  env: Bindings,
  path: string,
  body: PlaidRequestBody,
) => Promise<T>;

export class PlaidApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface PlaidErrorBody extends Record<string, unknown> {
  error_code?: unknown;
  error_message?: unknown;
}

export const plaidRequest: PlaidRequest = async <T>(
  env: Bindings,
  path: string,
  body: PlaidRequestBody,
) => {
  const credentials = plaidCredentials(env);
  const response = await fetch(`${baseUrl(env.PLAID_ENV)}${path}`, {
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      "PLAID-CLIENT-ID": credentials.clientId,
      "PLAID-SECRET": credentials.secret,
      "Plaid-Version": "2020-09-14",
    },
    method: "POST",
  });
  const result: unknown = await response.json().catch(() => null);
  if (response.ok) return result as T;
  throw plaidError(result, response.status);
};

function plaidCredentials(env: Bindings) {
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) {
    throw new PlaidApiError("Plaid is not configured.", "NOT_CONFIGURED", 503);
  }
  return { clientId: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET };
}

function baseUrl(environment: Bindings["PLAID_ENV"]) {
  if (environment === "production") return "https://production.plaid.com";
  if (environment === "development") return "https://development.plaid.com";
  return "https://sandbox.plaid.com";
}

function plaidError(value: unknown, status: number) {
  const body: PlaidErrorBody = isRecord(value) ? value : {};
  const message =
    typeof body.error_message === "string"
      ? body.error_message
      : "Plaid request failed.";
  const code =
    typeof body.error_code === "string" ? body.error_code : "PLAID_ERROR";
  return new PlaidApiError(message, code, status);
}

function isRecord(value: unknown): value is PlaidErrorBody {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
