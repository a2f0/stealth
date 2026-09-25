export function filterTransactionsByAccount<
  Transaction extends { accountId: string },
>(transactions: Transaction[] | undefined, accountId: string | undefined) {
  if (!transactions || !accountId) return transactions;
  return transactions.filter(
    (transaction) => transaction.accountId === accountId,
  );
}
