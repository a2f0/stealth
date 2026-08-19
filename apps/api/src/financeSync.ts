import {
  type PlaidAccount,
  PlaidApiError,
  type PlaidRequest,
  type PlaidTransaction,
  type TransactionsSyncResponse,
} from "./plaid";
import { decryptToken } from "./plaidCrypto";
import type { Bindings } from "./types";

export interface PlaidItemRow {
  access_token_ciphertext: string;
  access_token_iv: string;
  cursor: string | null;
  id: string;
}

interface SyncResult {
  added: number;
  modified: number;
  removed: number;
}

interface SyncRequest extends Record<string, unknown> {
  cursor?: string;
}

export async function syncPlaidItem(
  env: Bindings,
  organizationId: string,
  item: PlaidItemRow,
  requestPlaid: PlaidRequest,
): Promise<SyncResult> {
  const accessToken = await decryptAccessToken(env, organizationId, item);
  const initialCursor = item.cursor;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await syncPages(
        env,
        organizationId,
        item.id,
        accessToken,
        initialCursor,
        requestPlaid,
      );
    } catch (error) {
      if (!isPaginationMutation(error) || attempt === 2) {
        await recordSyncError(env.DB, item.id, error);
        throw error;
      }
    }
  }
  throw new Error("Plaid synchronization retry limit reached.");
}

async function syncPages(
  env: Bindings,
  organizationId: string,
  itemId: string,
  accessToken: string,
  initialCursor: string | null,
  requestPlaid: PlaidRequest,
) {
  let cursor = initialCursor;
  const total: SyncResult = { added: 0, modified: 0, removed: 0 };
  for (let page = 0; page < 100; page += 1) {
    const response = await requestPlaid<TransactionsSyncResponse>(
      env,
      "/transactions/sync",
      syncRequest(accessToken, cursor),
    );
    await persistPage(env.DB, organizationId, itemId, response);
    total.added += response.added.length;
    total.modified += response.modified.length;
    total.removed += response.removed.length;
    cursor = response.next_cursor;
    if (!response.has_more) {
      await recordSyncSuccess(env.DB, itemId, cursor);
      return total;
    }
  }
  throw new Error("Plaid synchronization exceeded 100 pages.");
}

function syncRequest(accessToken: string, cursor: string | null) {
  const body: SyncRequest = {
    access_token: accessToken,
    count: 500,
    options: {
      include_original_description: false,
      personal_finance_category_version: "v2",
    },
  };
  if (cursor) body.cursor = cursor;
  return body;
}

async function persistPage(
  database: D1Database,
  organizationId: string,
  itemId: string,
  page: TransactionsSyncResponse,
) {
  await runStatements(
    database,
    page.accounts.map((account) =>
      accountStatement(database, organizationId, itemId, account),
    ),
  );
  const updates = [...page.added, ...page.modified].map((transaction) =>
    transactionStatement(database, organizationId, itemId, transaction),
  );
  const removals = page.removed.map(({ transaction_id: transactionId }) =>
    database
      .prepare(
        `DELETE FROM plaid_transactions
         WHERE plaid_transaction_id = ? AND plaid_item_record_id = ?`,
      )
      .bind(transactionId, itemId),
  );
  await runStatements(database, [...updates, ...removals]);
}

function accountStatement(
  database: D1Database,
  organizationId: string,
  itemId: string,
  account: PlaidAccount,
) {
  return database
    .prepare(
      `INSERT INTO plaid_accounts
       (id, plaid_account_id, organization_id, plaid_item_record_id, name,
        official_name, mask, type, subtype, current_balance, available_balance,
        currency_code, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, official_name = excluded.official_name,
         mask = excluded.mask, type = excluded.type,
         subtype = excluded.subtype,
         current_balance = excluded.current_balance,
         available_balance = excluded.available_balance,
         currency_code = excluded.currency_code,
         updated_at = excluded.updated_at`,
    )
    .bind(
      accountRecordId(itemId, account.account_id),
      account.account_id,
      organizationId,
      itemId,
      account.name,
      account.official_name,
      account.mask,
      account.type,
      account.subtype,
      account.balances.current,
      account.balances.available,
      currency(account),
      new Date().toISOString(),
    );
}

function transactionStatement(
  database: D1Database,
  organizationId: string,
  itemId: string,
  transaction: PlaidTransaction,
) {
  return database
    .prepare(
      `INSERT INTO plaid_transactions
       (id, plaid_transaction_id, organization_id, plaid_item_record_id,
        account_record_id, name, merchant_name, amount, currency_code,
        transaction_date,
        authorized_date, category_primary, category_detailed, payment_channel,
        pending, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         account_record_id = excluded.account_record_id, name = excluded.name,
         merchant_name = excluded.merchant_name, amount = excluded.amount,
         currency_code = excluded.currency_code,
         transaction_date = excluded.transaction_date,
         authorized_date = excluded.authorized_date,
         category_primary = excluded.category_primary,
         category_detailed = excluded.category_detailed,
         payment_channel = excluded.payment_channel,
         pending = excluded.pending, updated_at = excluded.updated_at`,
    )
    .bind(
      transactionRecordId(itemId, transaction.transaction_id),
      transaction.transaction_id,
      organizationId,
      itemId,
      accountRecordId(itemId, transaction.account_id),
      transaction.name,
      transaction.merchant_name,
      transaction.amount,
      transaction.iso_currency_code ?? transaction.unofficial_currency_code,
      transaction.date,
      transaction.authorized_date,
      transaction.personal_finance_category?.primary ?? null,
      transaction.personal_finance_category?.detailed ?? null,
      transaction.payment_channel,
      transaction.pending ? 1 : 0,
      new Date().toISOString(),
    );
}

async function runStatements(
  database: D1Database,
  statements: D1PreparedStatement[],
) {
  for (let index = 0; index < statements.length; index += 75) {
    await database.batch(statements.slice(index, index + 75));
  }
}

async function decryptAccessToken(
  env: Bindings,
  organizationId: string,
  item: PlaidItemRow,
) {
  if (!env.PLAID_TOKEN_ENCRYPTION_KEY) {
    throw new PlaidApiError("Plaid is not configured.", "NOT_CONFIGURED", 503);
  }
  return decryptToken(
    {
      ciphertext: item.access_token_ciphertext,
      iv: item.access_token_iv,
    },
    env.PLAID_TOKEN_ENCRYPTION_KEY,
    `${organizationId}:${item.id}`,
  );
}

async function recordSyncSuccess(
  database: D1Database,
  itemId: string,
  cursor: string,
) {
  const now = new Date().toISOString();
  await database
    .prepare(
      `UPDATE plaid_items SET cursor = ?, status = 'active', error_code = NULL,
       last_synced_at = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(cursor, now, now, itemId)
    .run();
}

async function recordSyncError(
  database: D1Database,
  itemId: string,
  error: unknown,
) {
  const code = error instanceof PlaidApiError ? error.code : "SYNC_ERROR";
  await database
    .prepare(
      `UPDATE plaid_items SET status = 'error', error_code = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(code, new Date().toISOString(), itemId)
    .run();
}

function isPaginationMutation(error: unknown) {
  return (
    error instanceof PlaidApiError &&
    error.code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION"
  );
}

function currency(account: PlaidAccount) {
  return (
    account.balances.iso_currency_code ??
    account.balances.unofficial_currency_code
  );
}

function accountRecordId(itemId: string, accountId: string) {
  return `${itemId}:${accountId}`;
}

function transactionRecordId(itemId: string, transactionId: string) {
  return `${itemId}:${transactionId}`;
}
