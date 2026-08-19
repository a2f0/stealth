import {
  type Dispatch,
  type FormEvent,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  createPlaidLinkToken,
  deleteFinanceConnectionData,
  disconnectFinanceConnection,
  exchangePlaidPublicToken,
  type FinanceAccount,
  type FinanceConnection,
  type FinanceData,
  type FinanceTransaction,
  type FinanceTransactionAnnotationInput,
  getFinanceData,
  syncFinanceConnection,
  updateFinanceTransactionAnnotation,
} from "./financeApi";
import { filterTransactionsByAccount } from "./financeTransactions";

const linkTokenStorageKey = "stealth.plaid.linkToken";

export function Finance() {
  const [data, setData] = useState<FinanceData>();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const load = useCallback(async () => {
    try {
      setData(await getFinanceData());
    } catch (cause) {
      setError(messageFrom(cause));
    }
  }, []);
  useEffect(() => void load(), [load]);
  const plaid = usePlaidConnect(load, setError, setNotice);
  const actions = financeActions(load, setWorking, setError, setNotice);
  const busy = working || plaid.busy;

  return (
    <FinanceView
      busy={busy}
      data={data}
      error={error}
      notice={notice}
      onConnect={plaid.connect}
      onDeleteData={actions.deleteData}
      onDisconnect={actions.disconnect}
      onAnnotate={actions.annotate}
      onSync={actions.sync}
    />
  );
}

function financeActions(
  load: () => Promise<void>,
  setWorking: Dispatch<SetStateAction<boolean>>,
  setError: Dispatch<SetStateAction<string | undefined>>,
  setNotice: Dispatch<SetStateAction<string | undefined>>,
) {
  async function run(action: () => Promise<string>) {
    setWorking(true);
    setError(undefined);
    try {
      setNotice(await action());
      await load();
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setWorking(false);
    }
  }
  return {
    annotate: (
      transaction: FinanceTransaction,
      input: FinanceTransactionAnnotationInput,
    ) =>
      run(async () => {
        await updateFinanceTransactionAnnotation(transaction.id, input);
        return "Transaction annotation saved.";
      }),
    deleteData: async (connection: FinanceConnection) => {
      const name = connection.institutionName ?? "this institution";
      if (
        window.confirm(
          `Permanently delete all imported data for ${name}? This also deletes its transaction annotations and cannot be undone.`,
        )
      ) {
        await run(async () => {
          await deleteFinanceConnectionData(connection.id);
          return "Imported bank data permanently deleted.";
        });
      }
    },
    disconnect: async (connection: FinanceConnection) => {
      const name = connection.institutionName ?? "this institution";
      if (
        window.confirm(
          `Disconnect ${name}? Plaid access will be revoked, but imported transactions and annotations will remain.`,
        )
      ) {
        await run(async () => {
          await disconnectFinanceConnection(connection.id);
          return "Bank disconnected. Imported history was retained.";
        });
      }
    },
    sync: (id: string) =>
      run(async () => syncNotice(await syncFinanceConnection(id))),
  };
}

function FinanceView({
  busy,
  data,
  error,
  notice,
  onConnect,
  onDeleteData,
  onDisconnect,
  onAnnotate,
  onSync,
}: {
  busy: boolean;
  data: FinanceData | undefined;
  error: string | undefined;
  notice: string | undefined;
  onConnect: () => Promise<void>;
  onDeleteData: (connection: FinanceConnection) => Promise<void>;
  onDisconnect: (connection: FinanceConnection) => Promise<void>;
  onAnnotate: (
    transaction: FinanceTransaction,
    input: FinanceTransactionAnnotationInput,
  ) => Promise<void>;
  onSync: (id: string) => Promise<void>;
}) {
  const [selectedAccountId, setSelectedAccountId] = useState<string>();
  const [selectedTransactionId, setSelectedTransactionId] = useState<string>();
  const selectedAccount = data?.accounts.find(
    (account) => account.id === selectedAccountId,
  );
  const transactions = filterTransactionsByAccount(
    data?.transactions,
    selectedAccount?.id,
  );

  return (
    <>
      <header className="topbar">
        <div>
          <p className="eyebrow">Connected accounts</p>
          <h1>Finance</h1>
        </div>
        <button
          className="primaryButton"
          disabled={busy || data?.configured === false}
          onClick={() => void onConnect()}
          type="button"
        >
          {busy ? "Working…" : "+ Connect bank"}
        </button>
      </header>
      <section className="content financeContent">
        {error && <div className="errorBanner">{error}</div>}
        {notice && <div className="successBanner pageBanner">{notice}</div>}
        {data?.configured === false && <FinanceSetupNotice />}
        <Connections
          busy={busy}
          connections={data?.connections}
          onConnect={onConnect}
          onDeleteData={onDeleteData}
          onDisconnect={onDisconnect}
          onSync={onSync}
        />
        <AccountGrid
          accounts={data?.accounts}
          onSelect={(accountId) =>
            setSelectedAccountId((current) =>
              current === accountId ? undefined : accountId,
            )
          }
          selectedAccountId={selectedAccount?.id}
        />
        <TransactionHistory
          accountName={selectedAccount?.name}
          busy={busy}
          onAnnotate={onAnnotate}
          onClearFilter={() => setSelectedAccountId(undefined)}
          onSelectAnnotation={(transactionId) =>
            setSelectedTransactionId((current) =>
              current === transactionId ? undefined : transactionId,
            )
          }
          selectedTransactionId={selectedTransactionId}
          transactions={transactions}
        />
      </section>
    </>
  );
}

function usePlaidConnect(
  load: () => Promise<void>,
  setError: Dispatch<SetStateAction<string | undefined>>,
  setNotice: Dispatch<SetStateAction<string | undefined>>,
) {
  const [busy, setBusy] = useState(false);
  const resumedOAuth = useRef(false);
  const complete = useCallback(
    async (publicToken: string, metadata: PlaidLinkMetadata) => {
      setBusy(true);
      setError(undefined);
      try {
        const connection = await exchangePlaidPublicToken(publicToken, {
          id: metadata.institution?.institution_id ?? null,
          name: metadata.institution?.name ?? null,
        });
        clearOAuthState();
        const result = await syncFinanceConnection(connection.connectionId);
        await load();
        setNotice(syncNotice(result));
      } catch (cause) {
        setError(messageFrom(cause));
        await load();
      } finally {
        setBusy(false);
      }
    },
    [load, setError, setNotice],
  );
  useOAuthResume(complete, resumedOAuth, setBusy, setError);

  const connect = async () => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await createPlaidLinkToken();
      localStorage.setItem(linkTokenStorageKey, result.linkToken);
      launchPlaid(result.linkToken, undefined, complete, (message) => {
        setError(message);
        setBusy(false);
      });
    } catch (cause) {
      setError(messageFrom(cause));
      setBusy(false);
    }
  };
  return { busy, connect };
}

function useOAuthResume(
  complete: (token: string, metadata: PlaidLinkMetadata) => Promise<void>,
  resumed: { current: boolean },
  setBusy: Dispatch<SetStateAction<boolean>>,
  setError: Dispatch<SetStateAction<string | undefined>>,
) {
  useEffect(() => {
    if (!hasOAuthState() || resumed.current) return;
    resumed.current = true;
    const token = localStorage.getItem(linkTokenStorageKey);
    if (!token) {
      setError("The bank connection expired. Please start again.");
      clearOAuthState();
      return;
    }
    setBusy(true);
    launchPlaid(token, window.location.href, complete, (message) => {
      setError(message);
      setBusy(false);
    });
  }, [complete, resumed, setBusy, setError]);
}

function Connections({
  busy,
  connections,
  onConnect,
  onDeleteData,
  onDisconnect,
  onSync,
}: {
  busy: boolean;
  connections: FinanceConnection[] | undefined;
  onConnect: () => Promise<void>;
  onDeleteData: (connection: FinanceConnection) => Promise<void>;
  onDisconnect: (connection: FinanceConnection) => Promise<void>;
  onSync: (id: string) => Promise<void>;
}) {
  if (!connections?.length) return null;
  return (
    <section className="financeConnections">
      <div className="sectionHeading">
        <h2>Connections</h2>
        <span>{connections.length} institutions</span>
      </div>
      <div className="financeConnectionList">
        {connections.map((connection) => (
          <article key={connection.id}>
            <span className="financeInstitutionMark">$</span>
            <div>
              <strong>
                {connection.institutionName ?? "Financial institution"}
              </strong>
              <small>
                {connection.accountCount} accounts · {syncTime(connection)}
              </small>
            </div>
            <span className={`financeConnectionStatus ${connection.status}`}>
              {connection.status}
            </span>
            <div className="financeConnectionActions">
              {connection.status === "disconnected" ? (
                <>
                  <button
                    disabled={busy}
                    onClick={() => void onConnect()}
                    type="button"
                  >
                    Reconnect
                  </button>
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={() => void onDeleteData(connection)}
                    type="button"
                  >
                    Delete data
                  </button>
                </>
              ) : (
                <>
                  <button
                    disabled={busy}
                    onClick={() => void onSync(connection.id)}
                    type="button"
                  >
                    Sync now
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => void onDisconnect(connection)}
                    type="button"
                  >
                    Disconnect
                  </button>
                </>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function AccountGrid({
  accounts,
  onSelect,
  selectedAccountId,
}: {
  accounts: FinanceAccount[] | undefined;
  onSelect: (accountId: string) => void;
  selectedAccountId: string | undefined;
}) {
  if (!accounts?.length) return null;
  return (
    <section className="financeAccounts">
      <div className="sectionHeading">
        <h2>Accounts</h2>
        <span>{accounts.length} accounts</span>
      </div>
      <div className="financeAccountGrid">
        {accounts.map((account) => (
          <button
            aria-pressed={selectedAccountId === account.id}
            className={`financeAccountCard${
              selectedAccountId === account.id ? " selected" : ""
            }`}
            key={account.id}
            onClick={() => onSelect(account.id)}
            type="button"
          >
            <span>{account.institutionName ?? account.type}</span>
            <h3>{account.name}</h3>
            <strong>
              {formatMoney(account.currentBalance, account.currencyCode)}
            </strong>
            <small>
              {account.subtype ?? account.type}
              {account.mask ? ` · •••• ${account.mask}` : ""}
            </small>
          </button>
        ))}
      </div>
    </section>
  );
}

function TransactionHistory({
  accountName,
  busy,
  onAnnotate,
  onClearFilter,
  onSelectAnnotation,
  selectedTransactionId,
  transactions,
}: {
  accountName: string | undefined;
  busy: boolean;
  onAnnotate: (
    transaction: FinanceTransaction,
    input: FinanceTransactionAnnotationInput,
  ) => Promise<void>;
  onClearFilter: () => void;
  onSelectAnnotation: (transactionId: string) => void;
  selectedTransactionId: string | undefined;
  transactions: FinanceTransaction[] | undefined;
}) {
  const selectedTransaction = transactions?.find(
    (transaction) => transaction.id === selectedTransactionId,
  );
  return (
    <section className="financeTransactions">
      <div className="sectionHeading">
        <h2>Transactions</h2>
        <div className="financeTransactionSummary">
          <span>
            {transactions?.length ?? 0}
            {accountName ? ` for ${accountName}` : " recent"}
          </span>
          {accountName && (
            <button onClick={onClearFilter} type="button">
              All accounts
            </button>
          )}
        </div>
      </div>
      {selectedTransaction && (
        <TransactionAnnotationForm
          busy={busy}
          key={selectedTransaction.id}
          onClose={() => onSelectAnnotation(selectedTransaction.id)}
          onSave={(input) => onAnnotate(selectedTransaction, input)}
          transaction={selectedTransaction}
        />
      )}
      {transactions?.length ? (
        <div className="financeTransactionTable">
          {transactions.map((transaction) => (
            <article key={transaction.id}>
              <time dateTime={transaction.transactionDate}>
                {formatDate(transaction.transactionDate)}
              </time>
              <div>
                <strong>{transaction.merchantName ?? transaction.name}</strong>
                <div className="financeTransactionMeta">
                  <small>
                    {transaction.accountName} · {category(transaction)}
                    {transaction.annotation.reviewed ? " · reviewed" : ""}
                  </small>
                  <button
                    aria-expanded={selectedTransactionId === transaction.id}
                    className="financeAnnotationTrigger"
                    onClick={() => onSelectAnnotation(transaction.id)}
                    type="button"
                  >
                    {hasAnnotation(transaction) ? "Edit note" : "Annotate"}
                  </button>
                </div>
              </div>
              {transaction.pending && <span>Pending</span>}
              <b className={transaction.amount < 0 ? "credit" : "debit"}>
                {formatMoney(-transaction.amount, transaction.currencyCode)}
              </b>
            </article>
          ))}
        </div>
      ) : transactions ? (
        <div className="emptyState compactEmptyState financeEmptyState">
          <div className="emptyGlyph">$</div>
          <h3>
            {accountName
              ? `No transactions for ${accountName}.`
              : "No transactions imported yet."}
          </h3>
          <p>
            {accountName
              ? "Choose another account or show all accounts."
              : "Connect an account or sync an existing connection."}
          </p>
        </div>
      ) : (
        <p className="auditLoading">Loading finances…</p>
      )}
    </section>
  );
}

function TransactionAnnotationForm({
  busy,
  onClose,
  onSave,
  transaction,
}: {
  busy: boolean;
  onClose: () => void;
  onSave: (input: FinanceTransactionAnnotationInput) => Promise<void>;
  transaction: FinanceTransaction;
}) {
  const [categoryOverride, setCategoryOverride] = useState(
    transaction.annotation.categoryOverride ?? "",
  );
  const [labels, setLabels] = useState(
    transaction.annotation.labels.join(", "),
  );
  const [note, setNote] = useState(transaction.annotation.note);
  const [reviewed, setReviewed] = useState(transaction.annotation.reviewed);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      await onSave({
        categoryOverride: categoryOverride.trim() || null,
        labels: labels
          .split(",")
          .map((label) => label.trim())
          .filter(Boolean),
        note,
        reviewed,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="financeAnnotationForm"
      onSubmit={(event) => void submit(event)}
    >
      <div className="financeAnnotationHeading">
        <div>
          <span>Transaction annotation</span>
          <strong>{transaction.merchantName ?? transaction.name}</strong>
        </div>
        <button onClick={onClose} type="button">
          Close
        </button>
      </div>
      <div className="financeAnnotationFields">
        <label>
          Category override
          <input
            maxLength={100}
            onChange={(event) => setCategoryOverride(event.target.value)}
            placeholder={transaction.categoryPrimary ?? "Uncategorized"}
            value={categoryOverride}
          />
        </label>
        <label>
          Labels
          <input
            onChange={(event) => setLabels(event.target.value)}
            placeholder="tax, travel, follow up"
            value={labels}
          />
        </label>
      </div>
      <label>
        Note
        <textarea
          maxLength={2000}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Add context to this transaction…"
          rows={3}
          value={note}
        />
      </label>
      <div className="financeAnnotationFooter">
        <label className="financeReviewedField">
          <input
            checked={reviewed}
            onChange={(event) => setReviewed(event.target.checked)}
            type="checkbox"
          />
          Reviewed
        </label>
        <button
          className="primaryButton"
          disabled={busy || saving}
          type="submit"
        >
          {saving ? "Saving…" : "Save annotation"}
        </button>
      </div>
    </form>
  );
}

function FinanceSetupNotice() {
  return (
    <div className="financeSetupNotice">
      <strong>Plaid setup is incomplete.</strong>
      <p>
        Add the Plaid credentials and token-encryption key before connecting.
      </p>
    </div>
  );
}

function launchPlaid(
  token: string,
  receivedRedirectUri: string | undefined,
  onSuccess: (token: string, metadata: PlaidLinkMetadata) => Promise<void>,
  onExit: (message: string | undefined) => void,
) {
  if (!window.Plaid) {
    onExit("Plaid Link could not load. Check your connection and try again.");
    return;
  }
  let handler: PlaidLinkHandler | undefined;
  const configuration = {
    onExit: (error: PlaidLinkError | null) => {
      handler?.destroy();
      clearOAuthState();
      onExit(error?.error_message ?? undefined);
    },
    onSuccess: (publicToken: string, metadata: PlaidLinkMetadata) => {
      handler?.destroy();
      void onSuccess(publicToken, metadata);
    },
    token,
    ...(receivedRedirectUri ? { receivedRedirectUri } : {}),
  };
  handler = window.Plaid.create(configuration);
  handler.open();
}

function hasOAuthState() {
  return new URLSearchParams(window.location.search).has("oauth_state_id");
}

function clearOAuthState() {
  localStorage.removeItem(linkTokenStorageKey);
  if (hasOAuthState()) window.history.replaceState({}, "", "/finance");
}

function syncNotice(result: {
  added: number;
  modified: number;
  removed: number;
}) {
  return `Sync complete: ${result.added} added, ${result.modified} updated, ${result.removed} removed.`;
}

function syncTime(connection: FinanceConnection) {
  return connection.lastSyncedAt
    ? `synced ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(connection.lastSyncedAt))}`
    : "not synced yet";
}

function category(transaction: FinanceTransaction) {
  return (
    transaction.annotation.categoryOverride ??
    transaction.categoryPrimary ??
    "Uncategorized"
  )
    .toLowerCase()
    .replaceAll("_", " ");
}

function hasAnnotation(transaction: FinanceTransaction) {
  const annotation = transaction.annotation;
  return Boolean(
    annotation.note ||
      annotation.categoryOverride ||
      annotation.labels.length ||
      annotation.reviewed,
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
  }).format(new Date(`${value}T12:00:00`));
}

function formatMoney(value: number | null, currency: string | null) {
  if (value === null) return "—";
  return new Intl.NumberFormat(undefined, {
    currency: currency ?? "USD",
    currencyDisplay: "narrowSymbol",
    style: "currency",
  }).format(value);
}

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not update finances.";
}
