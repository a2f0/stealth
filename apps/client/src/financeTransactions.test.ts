import { describe, expect, it } from "bun:test";
import { filterTransactionsByAccount } from "./financeTransactions";

describe("finance transaction filters", () => {
  const transactions = [
    { accountId: "checking", id: "transaction-1" },
    { accountId: "savings", id: "transaction-2" },
    { accountId: "checking", id: "transaction-3" },
  ];

  it("shows only transactions for the selected account", () => {
    expect(
      filterTransactionsByAccount(transactions, "checking")?.map(
        (transaction) => transaction.id,
      ),
    ).toEqual(["transaction-1", "transaction-3"]);
  });

  it("shows every transaction when no account is selected", () => {
    expect(filterTransactionsByAccount(transactions, undefined)).toBe(
      transactions,
    );
  });
});
