import { and, eq, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { type AnySQLiteColumn, alias } from "drizzle-orm/sqlite-core";
import { type Db, excluded, getDb } from "./db";
import {
  type PlaidAccount,
  PlaidApiError,
  type PlaidRequest,
  type PlaidTransaction,
  type TransactionsSyncResponse,
} from "./plaid";
import { decryptToken } from "./plaidCrypto";
import { plaidAccounts, plaidItems, plaidTransactions } from "./schema";
import type { Bindings } from "./types";

interface PlaidItemRow {
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
  const db = getDb(database);
  const accountIds = new Map<string, string>();
  for (const account of page.accounts) {
    accountIds.set(
      account.account_id,
      await upsertAccount(database, organizationId, itemId, account),
    );
  }
  for (const transaction of [...page.added, ...page.modified]) {
    const accountId = accountIds.get(transaction.account_id);
    if (!accountId) {
      throw new Error("Plaid returned a transaction without its account.");
    }
    await upsertTransaction(
      database,
      organizationId,
      itemId,
      accountId,
      transaction,
    );
  }
  const removals = page.removed.map(({ transaction_id: transactionId }) =>
    db
      .update(plaidTransactions)
      .set({ sourceStatus: "removed", updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(plaidTransactions.plaidTransactionId, transactionId),
          eq(plaidTransactions.plaidItemRecordId, itemId),
        ),
      ),
  );
  await runStatements(db, removals);
}

async function upsertAccount(
  database: D1Database,
  organizationId: string,
  itemId: string,
  account: PlaidAccount,
) {
  const db = getDb(database);
  const existing = await db
    .select({ id: plaidAccounts.id })
    .from(plaidAccounts)
    .where(
      and(
        eq(plaidAccounts.plaidItemRecordId, itemId),
        eq(plaidAccounts.plaidAccountId, account.account_id),
      ),
    )
    .get();
  const candidates = existing
    ? []
    : await disconnectedAccountCandidates(
        database,
        organizationId,
        itemId,
        account,
      );
  const id =
    existing?.id ??
    (candidates.length === 1 ? candidates[0]?.id : undefined) ??
    crypto.randomUUID();
  await db
    .insert(plaidAccounts)
    .values({
      id,
      plaidAccountId: account.account_id,
      organizationId,
      plaidItemRecordId: itemId,
      name: account.name,
      officialName: account.official_name,
      mask: account.mask,
      type: account.type,
      subtype: account.subtype,
      currentBalance: account.balances.current,
      availableBalance: account.balances.available,
      currencyCode: currency(account),
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: plaidAccounts.id,
      set: {
        plaidAccountId: excluded(plaidAccounts.plaidAccountId),
        plaidItemRecordId: excluded(plaidAccounts.plaidItemRecordId),
        name: excluded(plaidAccounts.name),
        officialName: excluded(plaidAccounts.officialName),
        mask: excluded(plaidAccounts.mask),
        type: excluded(plaidAccounts.type),
        subtype: excluded(plaidAccounts.subtype),
        currentBalance: excluded(plaidAccounts.currentBalance),
        availableBalance: excluded(plaidAccounts.availableBalance),
        currencyCode: excluded(plaidAccounts.currencyCode),
        updatedAt: excluded(plaidAccounts.updatedAt),
      },
    });
  return id;
}

async function disconnectedAccountCandidates(
  database: D1Database,
  organizationId: string,
  itemId: string,
  account: PlaidAccount,
) {
  const archivedItem = alias(plaidItems, "archived_item");
  const currentItem = alias(plaidItems, "current_item");
  return getDb(database)
    .select({ id: plaidAccounts.id })
    .from(plaidAccounts)
    .innerJoin(
      archivedItem,
      eq(archivedItem.id, plaidAccounts.plaidItemRecordId),
    )
    .innerJoin(currentItem, eq(currentItem.id, itemId))
    .where(
      and(
        eq(plaidAccounts.organizationId, organizationId),
        eq(archivedItem.status, "disconnected"),
        sameText(archivedItem.institutionId, currentItem.institutionId),
        sameText(archivedItem.institutionName, currentItem.institutionName),
        sameText(plaidAccounts.mask, account.mask),
        eq(plaidAccounts.type, account.type),
        sameText(plaidAccounts.subtype, account.subtype),
      ),
    )
    .limit(2);
}

async function upsertTransaction(
  database: D1Database,
  organizationId: string,
  itemId: string,
  accountId: string,
  transaction: PlaidTransaction,
) {
  const existing = await findSourceTransaction(
    database,
    itemId,
    transaction.transaction_id,
  );
  const pending =
    !existing && transaction.pending_transaction_id
      ? await findSourceTransaction(
          database,
          itemId,
          transaction.pending_transaction_id,
        )
      : null;
  const candidates =
    existing || pending
      ? []
      : await disconnectedTransactionCandidates(
          database,
          organizationId,
          accountId,
          transaction,
        );
  const id =
    existing?.id ??
    pending?.id ??
    (candidates.length === 1 ? candidates[0]?.id : undefined) ??
    crypto.randomUUID();
  await getDb(database)
    .insert(plaidTransactions)
    .values({
      id,
      plaidTransactionId: transaction.transaction_id,
      organizationId,
      plaidItemRecordId: itemId,
      accountRecordId: accountId,
      name: transaction.name,
      merchantName: transaction.merchant_name,
      amount: transaction.amount,
      currencyCode:
        transaction.iso_currency_code ?? transaction.unofficial_currency_code,
      transactionDate: transaction.date,
      authorizedDate: transaction.authorized_date,
      categoryPrimary: transaction.personal_finance_category?.primary ?? null,
      categoryDetailed: transaction.personal_finance_category?.detailed ?? null,
      paymentChannel: transaction.payment_channel,
      pending: transaction.pending ? 1 : 0,
      pendingTransactionId: transaction.pending_transaction_id,
      sourceStatus: "active",
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: plaidTransactions.id,
      set: {
        plaidTransactionId: excluded(plaidTransactions.plaidTransactionId),
        plaidItemRecordId: excluded(plaidTransactions.plaidItemRecordId),
        accountRecordId: excluded(plaidTransactions.accountRecordId),
        name: excluded(plaidTransactions.name),
        merchantName: excluded(plaidTransactions.merchantName),
        amount: excluded(plaidTransactions.amount),
        currencyCode: excluded(plaidTransactions.currencyCode),
        transactionDate: excluded(plaidTransactions.transactionDate),
        authorizedDate: excluded(plaidTransactions.authorizedDate),
        categoryPrimary: excluded(plaidTransactions.categoryPrimary),
        categoryDetailed: excluded(plaidTransactions.categoryDetailed),
        paymentChannel: excluded(plaidTransactions.paymentChannel),
        pending: excluded(plaidTransactions.pending),
        pendingTransactionId: excluded(plaidTransactions.pendingTransactionId),
        sourceStatus: "active",
        updatedAt: excluded(plaidTransactions.updatedAt),
      },
    });
}

function findSourceTransaction(
  database: D1Database,
  itemId: string,
  plaidTransactionId: string,
) {
  return getDb(database)
    .select({ id: plaidTransactions.id })
    .from(plaidTransactions)
    .where(
      and(
        eq(plaidTransactions.plaidItemRecordId, itemId),
        eq(plaidTransactions.plaidTransactionId, plaidTransactionId),
      ),
    )
    .get();
}

async function disconnectedTransactionCandidates(
  database: D1Database,
  organizationId: string,
  accountId: string,
  transaction: PlaidTransaction,
) {
  return getDb(database)
    .select({ id: plaidTransactions.id })
    .from(plaidTransactions)
    .innerJoin(
      plaidItems,
      eq(plaidItems.id, plaidTransactions.plaidItemRecordId),
    )
    .where(
      and(
        eq(plaidTransactions.organizationId, organizationId),
        eq(plaidTransactions.accountRecordId, accountId),
        eq(plaidItems.status, "disconnected"),
        eq(plaidTransactions.sourceStatus, "active"),
        eq(plaidTransactions.transactionDate, transaction.date),
        sameText(plaidTransactions.authorizedDate, transaction.authorized_date),
        eq(plaidTransactions.amount, transaction.amount),
        sameText(
          plaidTransactions.currencyCode,
          transaction.iso_currency_code ?? transaction.unofficial_currency_code,
        ),
        eq(plaidTransactions.name, transaction.name),
        sameText(plaidTransactions.merchantName, transaction.merchant_name),
        eq(plaidTransactions.pending, transaction.pending ? 1 : 0),
      ),
    )
    .limit(2);
}

async function runStatements(db: Db, statements: BatchItem<"sqlite">[]) {
  for (let index = 0; index < statements.length; index += 75) {
    const [first, ...rest] = statements.slice(index, index + 75);
    if (first) await db.batch([first, ...rest]);
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
  await getDb(database)
    .update(plaidItems)
    .set({
      cursor,
      status: "active",
      errorCode: null,
      lastSyncedAt: now,
      updatedAt: now,
    })
    .where(eq(plaidItems.id, itemId));
}

async function recordSyncError(
  database: D1Database,
  itemId: string,
  error: unknown,
) {
  const code = error instanceof PlaidApiError ? error.code : "SYNC_ERROR";
  await getDb(database)
    .update(plaidItems)
    .set({
      status: "error",
      errorCode: code,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(plaidItems.id, itemId));
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

/** Compares two nullable text values, treating NULL as an empty string. */
function sameText(
  column: AnySQLiteColumn,
  value: AnySQLiteColumn | string | null,
) {
  return sql`coalesce(${column}, '') = coalesce(${value}, '')`;
}
