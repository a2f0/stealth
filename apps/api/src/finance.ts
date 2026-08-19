import { type Context, Hono } from "hono";
import type { AuthVariables } from "./authMiddleware";
import { type PlaidItemRow, syncPlaidItem } from "./financeSync";
import { PlaidApiError, type PlaidRequest, plaidRequest } from "./plaid";
import { decryptToken, encryptToken } from "./plaidCrypto";
import type { Bindings } from "./types";

interface ConnectionRow {
  account_count: number;
  created_at: string;
  error_code: string | null;
  id: string;
  institution_id: string | null;
  institution_name: string | null;
  last_synced_at: string | null;
  status: string;
}

interface AccountRow {
  available_balance: number | null;
  currency_code: string | null;
  current_balance: number | null;
  id: string;
  institution_name: string | null;
  mask: string | null;
  name: string;
  official_name: string | null;
  subtype: string | null;
  type: string;
}

interface TransactionRow {
  account_id: string;
  account_name: string;
  amount: number;
  authorized_date: string | null;
  category_detailed: string | null;
  category_primary: string | null;
  currency_code: string | null;
  id: string;
  merchant_name: string | null;
  name: string;
  payment_channel: string | null;
  pending: number;
  transaction_date: string;
}

interface ExchangeResponse {
  access_token: string;
  item_id: string;
}

interface LinkTokenResponse {
  expiration: string;
  link_token: string;
}

interface FinanceInput {
  institutionId?: unknown;
  institutionName?: unknown;
  publicToken?: unknown;
  [key: string]: unknown;
}

interface LinkTokenRequest extends Record<string, unknown> {
  redirect_uri?: string;
}

type FinanceEnv = {
  Bindings: Bindings;
  Variables: AuthVariables;
};
type FinanceContext = Context<FinanceEnv>;

export function createFinanceRouter(requestPlaid: PlaidRequest = plaidRequest) {
  const finance = new Hono<FinanceEnv>();

  finance.get("/", async (context) => financeListing(context));
  finance.post("/link-token", async (context) =>
    createLinkToken(context, requestPlaid),
  );
  finance.post("/exchange", async (context) =>
    exchangePublicToken(context, requestPlaid),
  );
  finance.post("/connections/:id/sync", async (context) =>
    syncConnection(context, requestPlaid),
  );
  finance.delete("/connections/:id", async (context) =>
    disconnectConnection(context, requestPlaid),
  );
  finance.onError((error, context) => {
    if (error instanceof PlaidApiError) {
      const status = error.status === 503 ? 503 : 502;
      return context.json({ code: error.code, error: error.message }, status);
    }
    console.error(error);
    return context.json({ error: "Unexpected finance error." }, 500);
  });
  return finance;
}

async function financeListing(context: FinanceContext) {
  const organizationId = context.get("organizationId");
  const [connections, accounts, transactions] = await Promise.all([
    listConnections(context.env.DB, organizationId),
    listAccounts(context.env.DB, organizationId),
    listTransactions(context.env.DB, organizationId),
  ]);
  return context.json({
    accounts: accounts.map(toAccount),
    configured: isConfigured(context.env),
    connections: connections.map(toConnection),
    transactions: transactions.map(toTransaction),
  });
}

async function createLinkToken(
  context: FinanceContext,
  requestPlaid: PlaidRequest,
) {
  requireEncryptionKey(context.env);
  const body: LinkTokenRequest = {
    client_name: "Stealth",
    country_codes: ["US"],
    language: "en",
    products: ["transactions"],
    transactions: { days_requested: 730 },
    user: {
      client_user_id: clientUserId(
        context.get("organizationId"),
        context.get("authSession").user.id,
      ),
    },
  };
  if (context.env.PLAID_REDIRECT_URI) {
    body.redirect_uri = context.env.PLAID_REDIRECT_URI;
  }
  const result = await requestPlaid<LinkTokenResponse>(
    context.env,
    "/link/token/create",
    body,
  );
  return context.json({
    expiration: result.expiration,
    linkToken: result.link_token,
  });
}

async function exchangePublicToken(
  context: FinanceContext,
  requestPlaid: PlaidRequest,
) {
  const input = await financeInput(context);
  if (!validText(input?.publicToken, 1_000)) {
    return context.json({ error: "A Plaid public token is required." }, 400);
  }
  const secret = requireEncryptionKey(context.env);
  const result = await requestPlaid<ExchangeResponse>(
    context.env,
    "/item/public_token/exchange",
    { public_token: input.publicToken },
  );
  const organizationId = context.get("organizationId");
  const existing = await findItemByPlaidId(context.env.DB, result.item_id);
  if (existing) {
    return existing.organizationId === organizationId
      ? context.json({ connectionId: existing.id })
      : context.json({ error: "That connection is already in use." }, 409);
  }
  const id = crypto.randomUUID();
  const encrypted = await encryptToken(
    result.access_token,
    secret,
    `${organizationId}:${id}`,
  );
  await insertConnection(context, input, result, encrypted, id);
  return context.json({ connectionId: id }, 201);
}

async function syncConnection(
  context: FinanceContext,
  requestPlaid: PlaidRequest,
) {
  const connectionId = context.req.param("id");
  if (!connectionId) {
    return context.json({ error: "Connection not found." }, 404);
  }
  const item = await findItem(
    context.env.DB,
    context.get("organizationId"),
    connectionId,
  );
  if (!item) return context.json({ error: "Connection not found." }, 404);
  const result = await syncPlaidItem(
    context.env,
    context.get("organizationId"),
    item,
    requestPlaid,
  );
  return context.json(result);
}

async function disconnectConnection(
  context: FinanceContext,
  requestPlaid: PlaidRequest,
) {
  const connectionId = context.req.param("id");
  if (!connectionId) {
    return context.json({ error: "Connection not found." }, 404);
  }
  const organizationId = context.get("organizationId");
  const item = await findItem(context.env.DB, organizationId, connectionId);
  if (!item) return context.json({ error: "Connection not found." }, 404);
  const accessToken = await decryptToken(
    {
      ciphertext: item.access_token_ciphertext,
      iv: item.access_token_iv,
    },
    requireEncryptionKey(context.env),
    `${organizationId}:${item.id}`,
  );
  await requestPlaid(context.env, "/item/remove", {
    access_token: accessToken,
  });
  await context.env.DB.batch([
    context.env.DB.prepare(
      `DELETE FROM plaid_transactions
         WHERE plaid_item_record_id = ? AND organization_id = ?`,
    ).bind(item.id, organizationId),
    context.env.DB.prepare(
      `DELETE FROM plaid_accounts
         WHERE plaid_item_record_id = ? AND organization_id = ?`,
    ).bind(item.id, organizationId),
    context.env.DB.prepare(
      "DELETE FROM plaid_items WHERE id = ? AND organization_id = ?",
    ).bind(item.id, organizationId),
  ]);
  return context.body(null, 204);
}

async function insertConnection(
  context: FinanceContext,
  input: FinanceInput,
  exchange: ExchangeResponse,
  encrypted: { ciphertext: string; iv: string },
  id: string,
) {
  const now = new Date().toISOString();
  await context.env.DB.prepare(
    `INSERT INTO plaid_items
     (id, organization_id, plaid_item_id, access_token_ciphertext,
      access_token_iv, institution_id, institution_name, status, created_by,
      created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
  )
    .bind(
      id,
      context.get("organizationId"),
      exchange.item_id,
      encrypted.ciphertext,
      encrypted.iv,
      optionalText(input.institutionId, 100),
      optionalText(input.institutionName, 200),
      context.get("authSession").user.id,
      now,
      now,
    )
    .run();
}

async function listConnections(database: D1Database, organizationId: string) {
  const result = await database
    .prepare(
      `SELECT item.id, item.institution_id, item.institution_name, item.status,
              item.error_code, item.last_synced_at, item.created_at,
              COUNT(account.id) AS account_count
       FROM plaid_items AS item
       LEFT JOIN plaid_accounts AS account
         ON account.plaid_item_record_id = item.id
       WHERE item.organization_id = ?
       GROUP BY item.id ORDER BY item.created_at DESC`,
    )
    .bind(organizationId)
    .all<ConnectionRow>();
  return result.results;
}

async function listAccounts(database: D1Database, organizationId: string) {
  const result = await database
    .prepare(
      `SELECT account.id, account.name, account.official_name, account.mask,
              account.type, account.subtype, account.current_balance,
              account.available_balance, account.currency_code,
              item.institution_name
       FROM plaid_accounts AS account
       JOIN plaid_items AS item ON item.id = account.plaid_item_record_id
       WHERE account.organization_id = ? ORDER BY account.name ASC`,
    )
    .bind(organizationId)
    .all<AccountRow>();
  return result.results;
}

async function listTransactions(database: D1Database, organizationId: string) {
  const result = await database
    .prepare(
      `SELECT txn.id, txn.name, txn.merchant_name,
              txn.amount, txn.currency_code,
              txn.transaction_date, txn.authorized_date,
              txn.category_primary, txn.category_detailed,
              txn.payment_channel, txn.pending,
              account.id AS account_id, account.name AS account_name
       FROM plaid_transactions AS txn
       JOIN plaid_accounts AS account
         ON account.id = txn.account_record_id
       WHERE txn.organization_id = ?
       ORDER BY txn.transaction_date DESC, txn.id DESC
       LIMIT 250`,
    )
    .bind(organizationId)
    .all<TransactionRow>();
  return result.results;
}

async function findItem(
  database: D1Database,
  organizationId: string,
  id: string,
) {
  return database
    .prepare(
      `SELECT id, access_token_ciphertext, access_token_iv, cursor
       FROM plaid_items WHERE id = ? AND organization_id = ?`,
    )
    .bind(id, organizationId)
    .first<PlaidItemRow>();
}

async function findItemByPlaidId(database: D1Database, plaidItemId: string) {
  return database
    .prepare(
      `SELECT id, organization_id AS organizationId
       FROM plaid_items WHERE plaid_item_id = ?`,
    )
    .bind(plaidItemId)
    .first<{ id: string; organizationId: string }>();
}

function toConnection(row: ConnectionRow) {
  return {
    accountCount: row.account_count,
    createdAt: row.created_at,
    errorCode: row.error_code,
    id: row.id,
    institutionId: row.institution_id,
    institutionName: row.institution_name,
    lastSyncedAt: row.last_synced_at,
    status: row.status,
  };
}

function toAccount(row: AccountRow) {
  return {
    availableBalance: row.available_balance,
    currencyCode: row.currency_code,
    currentBalance: row.current_balance,
    id: row.id,
    institutionName: row.institution_name,
    mask: row.mask,
    name: row.name,
    officialName: row.official_name,
    subtype: row.subtype,
    type: row.type,
  };
}

function toTransaction(row: TransactionRow) {
  return {
    accountId: row.account_id,
    accountName: row.account_name,
    amount: row.amount,
    authorizedDate: row.authorized_date,
    categoryDetailed: row.category_detailed,
    categoryPrimary: row.category_primary,
    currencyCode: row.currency_code,
    id: row.id,
    merchantName: row.merchant_name,
    name: row.name,
    paymentChannel: row.payment_channel,
    pending: Boolean(row.pending),
    transactionDate: row.transaction_date,
  };
}

function requireEncryptionKey(env: Bindings) {
  if (!env.PLAID_TOKEN_ENCRYPTION_KEY) {
    throw new PlaidApiError("Plaid is not configured.", "NOT_CONFIGURED", 503);
  }
  return env.PLAID_TOKEN_ENCRYPTION_KEY;
}

function isConfigured(env: Bindings) {
  return Boolean(
    env.PLAID_CLIENT_ID && env.PLAID_SECRET && env.PLAID_TOKEN_ENCRYPTION_KEY,
  );
}

function clientUserId(organizationId: string, userId: string) {
  return `${organizationId}:${userId}`.slice(0, 128);
}

async function financeInput(context: FinanceContext) {
  const input: unknown = await context.req.json().catch(() => null);
  return isRecord(input) ? input : null;
}

function isRecord(value: unknown): value is FinanceInput {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength
  );
}

function optionalText(value: unknown, maxLength: number) {
  return typeof value === "string" && value.trim().length <= maxLength
    ? value.trim() || null
    : null;
}

export const finance = createFinanceRouter();
