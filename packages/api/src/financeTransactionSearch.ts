import { and, desc, eq, or, sql } from "drizzle-orm";
import { getDb } from "./db";
import type { FinanceContext } from "./financeContext";
import { plaidAccounts, plaidTransactions } from "./schema";

interface TransactionMatchRow {
  account_name: string;
  amount: number;
  currency_code: string | null;
  id: string;
  merchant_name: string | null;
  name: string;
  transaction_date: string;
}

const maxQueryLength = 100;
const resultLimit = 25;

/**
 * Finds imported transactions by name, merchant, or amount so another
 * record, such as an inbox email, can be linked to one. Without a query it
 * returns the most recent transactions.
 */
export async function searchTransactions(context: FinanceContext) {
  const query = (context.req.query("q") ?? "").trim();
  if (query.length > maxQueryLength) {
    return context.json(
      { error: `Searches need ${maxQueryLength} characters or fewer.` },
      400,
    );
  }
  const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
  const amount = amountFrom(query);
  const rows = await getDb(context.env.DB)
    .select({
      id: plaidTransactions.id,
      name: plaidTransactions.name,
      merchant_name: plaidTransactions.merchantName,
      amount: plaidTransactions.amount,
      currency_code: plaidTransactions.currencyCode,
      transaction_date: plaidTransactions.transactionDate,
      account_name: plaidAccounts.name,
    })
    .from(plaidTransactions)
    .innerJoin(
      plaidAccounts,
      eq(plaidAccounts.id, plaidTransactions.accountRecordId),
    )
    .where(
      and(
        eq(plaidTransactions.organizationId, context.get("organizationId")),
        eq(plaidTransactions.sourceStatus, "active"),
        query === ""
          ? undefined
          : or(
              sql`${plaidTransactions.name} like ${pattern} escape '\\'`,
              sql`${plaidTransactions.merchantName} like ${pattern} escape '\\'`,
              amount === null
                ? undefined
                : sql`abs(abs(${plaidTransactions.amount}) - ${amount}) < 0.005`,
            ),
      ),
    )
    .orderBy(
      desc(plaidTransactions.transactionDate),
      desc(plaidTransactions.id),
    )
    .limit(resultLimit);
  return context.json({ transactions: rows.map(toMatch) });
}

/** "42.75", "$42.75", or "1,042" as an unsigned amount; otherwise null. */
function amountFrom(query: string) {
  const normalized = query.replace(/^\$/, "").replaceAll(",", "");
  return /^\d+(\.\d{1,2})?$/.test(normalized) ? Number(normalized) : null;
}

function toMatch(row: TransactionMatchRow) {
  return {
    accountName: row.account_name,
    amount: row.amount,
    currencyCode: row.currency_code,
    id: row.id,
    merchantName: row.merchant_name,
    name: row.name,
    transactionDate: row.transaction_date,
  };
}
