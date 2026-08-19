import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  createPlaidLinkToken,
  disconnectFinanceConnection,
  exchangePlaidPublicToken,
  type FinanceAccount,
  type FinanceConnection,
  type FinanceData,
  type FinanceTransaction,
  getFinanceData,
  syncFinanceConnection,
} from "./financeApi";

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
  const busy = working || plaid.busy;

  async function sync(id: string) {
    setWorking(true);
    setError(undefined);
    try {
      setNotice(syncNotice(await syncFinanceConnection(id)));
      await load();
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setWorking(false);
    }
  }

  async function disconnect(connection: FinanceConnection) {
    const name = connection.institutionName ?? "this institution";
    if (!window.confirm(`Disconnect ${name}?`)) return;
    setWorking(true);
    setError(undefined);
    try {
      await disconnectFinanceConnection(connection.id);
      setNotice("Bank connection removed.");
      await load();
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setWorking(false);
    }
  }

  return (
    <FinanceView
      busy={busy}
      data={data}
      error={error}
      notice={notice}
      onConnect={plaid.connect}
      onDisconnect={disconnect}
      onSync={sync}
    />
  );
}

function FinanceView({
  busy,
  data,
  error,
  notice,
  onConnect,
  onDisconnect,
  onSync,
}: {
  busy: boolean;
  data: FinanceData | undefined;
  error: string | undefined;
  notice: string | undefined;
  onConnect: () => Promise<void>;
  onDisconnect: (connection: FinanceConnection) => Promise<void>;
  onSync: (id: string) => Promise<void>;
}) {
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
          onDisconnect={onDisconnect}
          onSync={onSync}
        />
        <AccountGrid accounts={data?.accounts} />
        <TransactionHistory transactions={data?.transactions} />
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
  onDisconnect,
  onSync,
}: {
  busy: boolean;
  connections: FinanceConnection[] | undefined;
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
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function AccountGrid({ accounts }: { accounts: FinanceAccount[] | undefined }) {
  if (!accounts?.length) return null;
  return (
    <section className="financeAccounts">
      <div className="sectionHeading">
        <h2>Accounts</h2>
        <span>{accounts.length} accounts</span>
      </div>
      <div className="financeAccountGrid">
        {accounts.map((account) => (
          <article key={account.id}>
            <span>{account.institutionName ?? account.type}</span>
            <h3>{account.name}</h3>
            <strong>
              {formatMoney(account.currentBalance, account.currencyCode)}
            </strong>
            <small>
              {account.subtype ?? account.type}
              {account.mask ? ` · •••• ${account.mask}` : ""}
            </small>
          </article>
        ))}
      </div>
    </section>
  );
}

function TransactionHistory({
  transactions,
}: {
  transactions: FinanceTransaction[] | undefined;
}) {
  return (
    <section className="financeTransactions">
      <div className="sectionHeading">
        <h2>Transactions</h2>
        <span>{transactions?.length ?? 0} recent</span>
      </div>
      {transactions?.length ? (
        <div className="financeTransactionTable">
          {transactions.map((transaction) => (
            <article key={transaction.id}>
              <time dateTime={transaction.transactionDate}>
                {formatDate(transaction.transactionDate)}
              </time>
              <div>
                <strong>{transaction.merchantName ?? transaction.name}</strong>
                <small>
                  {transaction.accountName} · {category(transaction)}
                </small>
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
          <h3>No transactions imported yet.</h3>
          <p>Connect an account or sync an existing connection.</p>
        </div>
      ) : (
        <p className="auditLoading">Loading finances…</p>
      )}
    </section>
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
  return (transaction.categoryPrimary ?? "Uncategorized")
    .toLowerCase()
    .replaceAll("_", " ");
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
