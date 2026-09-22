import {
  Avatar,
  Badge,
  type BadgeTone,
  Banner,
  Button,
  ButtonLink,
  Card,
  cx,
  EmptyState,
  Field,
  Icon,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
} from "@tearleads/ui/react";
import {
  type Dispatch,
  type FormEvent,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { websiteUrl } from "./config";
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
import { countLabel, formatLabel } from "./labels";

const linkTokenStorageKey = "tearleads.plaid.linkToken";

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

const setupNoticeId = "finance-setup-notice";

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
  const unconfigured = data?.configured === false;

  return (
    <Page>
      <FinanceHeader
        busy={busy}
        onConnect={onConnect}
        unconfigured={unconfigured}
      />
      <PageBody>
        <FinanceNotices
          error={error}
          notice={notice}
          unconfigured={unconfigured}
        />
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
      </PageBody>
    </Page>
  );
}

function FinanceHeader({
  busy,
  onConnect,
  unconfigured,
}: {
  busy: boolean;
  onConnect: () => Promise<void>;
  unconfigured: boolean;
}) {
  return (
    <PageHeader
      actions={
        <Button
          aria-describedby={unconfigured ? setupNoticeId : undefined}
          busy={busy}
          disabled={unconfigured}
          icon="add"
          onClick={() => void onConnect()}
          variant="primary"
        >
          {busy ? "Working…" : "Connect bank"}
        </Button>
      }
      description="Balances and transactions from your connected institutions, ready for your team to review and annotate."
      eyebrow="Connected accounts"
      title="Finance"
    />
  );
}

function FinanceNotices({
  error,
  notice,
  unconfigured,
}: {
  error: string | undefined;
  notice: string | undefined;
  unconfigured: boolean;
}) {
  return (
    <div className="stack stackMd">
      {error && <Banner tone="danger">{error}</Banner>}
      {notice && <Banner tone="success">{notice}</Banner>}
      {unconfigured && <FinanceSetupNotice />}
      <FinanceDataNotice />
    </div>
  );
}

function FinanceDataNotice() {
  return (
    <Banner
      announce={false}
      icon="lock"
      title="Before you add an account"
      tone="neutral"
    >
      <p>
        Plaid securely connects your institution. Tearleads imports up to 24
        months of account balances and transaction details so authorized
        organization members can review and annotate them. We do not receive
        your bank credentials, never sell customer information, and let you
        disconnect later.{" "}
        <ButtonLink
          href={`${websiteUrl}/privacy`}
          iconEnd="external"
          variant="link"
        >
          Privacy details
        </ButtonLink>
      </p>
    </Banner>
  );
}

function FinanceSetupNotice() {
  return (
    <div id={setupNoticeId}>
      <Banner
        announce={false}
        icon="key"
        title="Plaid setup is incomplete"
        tone="warning"
      >
        Add the Plaid credentials and token-encryption key before connecting.
      </Banner>
    </div>
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

interface ConnectionHandlers {
  busy: boolean;
  onConnect: () => Promise<void>;
  onDeleteData: (connection: FinanceConnection) => Promise<void>;
  onDisconnect: (connection: FinanceConnection) => Promise<void>;
  onSync: (id: string) => Promise<void>;
}

function Connections({
  connections,
  ...handlers
}: ConnectionHandlers & {
  connections: FinanceConnection[] | undefined;
}) {
  if (!connections?.length) return null;
  return (
    <PageSection
      actions={
        <span className="sectionCount">
          {countLabel(connections.length, "institution")}
        </span>
      }
      title="Connections"
    >
      <Card className="financeListCard" flush>
        <ul className="rowList financeConnections">
          {connections.map((connection) => (
            <ConnectionRow
              connection={connection}
              key={connection.id}
              {...handlers}
            />
          ))}
        </ul>
      </Card>
    </PageSection>
  );
}

function ConnectionRow({
  connection,
  ...handlers
}: ConnectionHandlers & { connection: FinanceConnection }) {
  const name = connection.institutionName ?? "Financial institution";
  return (
    <li className="row financeConnection">
      <Avatar className="financeInstitutionMark" name={name} size="lg" />
      <div className="rowMain financeConnectionMain">
        <span className="rowTitle financeConnectionName">{name}</span>
        <span className="rowMeta financeConnectionMeta">
          {countLabel(connection.accountCount, "account")} ·{" "}
          {syncTime(connection)}
          {connection.status === "error" && connection.errorCode && (
            <>
              {" · "}
              <span className="mono">{connection.errorCode}</span>
            </>
          )}
        </span>
      </div>
      <Badge
        className="financeConnectionStatus"
        dot
        tone={connectionTone(connection.status)}
      >
        {formatLabel(connection.status)}
      </Badge>
      <ConnectionActions connection={connection} {...handlers} />
    </li>
  );
}

function ConnectionActions({
  busy,
  connection,
  onConnect,
  onDeleteData,
  onDisconnect,
  onSync,
}: ConnectionHandlers & { connection: FinanceConnection }) {
  if (connection.status === "disconnected") {
    return (
      <div className="rowActions financeConnectionActions">
        <Button
          disabled={busy}
          icon="refresh"
          onClick={() => void onConnect()}
          size="sm"
        >
          Reconnect
        </Button>
        <Button
          disabled={busy}
          icon="trash"
          onClick={() => void onDeleteData(connection)}
          size="sm"
          variant="danger"
        >
          Delete data
        </Button>
      </div>
    );
  }
  return (
    <div className="rowActions financeConnectionActions">
      <Button
        disabled={busy}
        icon="refresh"
        onClick={() => void onSync(connection.id)}
        size="sm"
      >
        Sync now
      </Button>
      <Button
        disabled={busy}
        icon="unlink"
        onClick={() => void onDisconnect(connection)}
        size="sm"
        variant="ghost"
      >
        Disconnect
      </Button>
    </div>
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
    <PageSection
      actions={
        <span className="sectionCount">
          {countLabel(accounts.length, "account")}
        </span>
      }
      description="Select an account to filter its transactions."
      title="Accounts"
    >
      <div className="gridAuto financeAccountGrid">
        {accounts.map((account) => (
          <AccountCard
            account={account}
            key={account.id}
            onSelect={onSelect}
            selected={selectedAccountId === account.id}
          />
        ))}
      </div>
    </PageSection>
  );
}

function AccountCard({
  account,
  onSelect,
  selected,
}: {
  account: FinanceAccount;
  onSelect: (accountId: string) => void;
  selected: boolean;
}) {
  return (
    <button
      aria-pressed={selected}
      className={cx(
        "card cardInteractive financeAccount",
        selected && "cardSelected",
      )}
      onClick={() => onSelect(account.id)}
      type="button"
    >
      <span className="financeAccountHeader">
        <span className="financeAccountInstitution">
          {account.institutionName ?? account.type}
        </span>
        {selected && (
          <span className="financeAccountCheck">
            <Icon name="check" size={14} strokeWidth={2.5} />
          </span>
        )}
      </span>
      <span className="financeAccountName">{account.name}</span>
      <span className="financeAccountBalance">
        {formatMoney(account.currentBalance, account.currencyCode)}
      </span>
      <span className="financeAccountMeta">
        {formatLabel(account.subtype ?? account.type)}
        {account.mask ? ` · ••••\u00a0${account.mask}` : ""}
      </span>
    </button>
  );
}

interface AnnotationHandlers {
  busy: boolean;
  onAnnotate: (
    transaction: FinanceTransaction,
    input: FinanceTransactionAnnotationInput,
  ) => Promise<void>;
  onSelectAnnotation: (transactionId: string) => void;
  selectedTransactionId: string | undefined;
}

function TransactionHistory({
  accountName,
  onClearFilter,
  transactions,
  ...handlers
}: AnnotationHandlers & {
  accountName: string | undefined;
  onClearFilter: () => void;
  transactions: FinanceTransaction[] | undefined;
}) {
  return (
    <PageSection
      actions={
        (accountName || Boolean(transactions?.length)) && (
          <div className="cluster">
            <span className="sectionCount">
              {transactions?.length ?? 0}
              {accountName ? ` for ${accountName}` : " recent"}
            </span>
            {accountName && (
              <Button
                icon="close"
                onClick={onClearFilter}
                size="sm"
                variant="ghost"
              >
                All accounts
              </Button>
            )}
          </div>
        )
      }
      title="Transactions"
    >
      <TransactionContent
        accountName={accountName}
        transactions={transactions}
        {...handlers}
      />
    </PageSection>
  );
}

function TransactionContent({
  accountName,
  transactions,
  ...handlers
}: AnnotationHandlers & {
  accountName: string | undefined;
  transactions: FinanceTransaction[] | undefined;
}) {
  if (!transactions) return <LoadingState label="Loading finances…" />;
  if (!transactions.length) {
    return (
      <EmptyState
        icon={accountName ? "search" : "finance"}
        title={
          accountName
            ? `No transactions for ${accountName}`
            : "No transactions imported yet"
        }
      >
        {accountName
          ? "Choose another account or show all accounts."
          : "Connect an account or sync an existing connection."}
      </EmptyState>
    );
  }
  return (
    <Card className="financeListCard" flush>
      <ul className="rowList financeTransactions">
        {transactions.map((transaction) => (
          <TransactionRow
            key={transaction.id}
            transaction={transaction}
            {...handlers}
          />
        ))}
      </ul>
    </Card>
  );
}

function TransactionRow({
  busy,
  onAnnotate,
  onSelectAnnotation,
  selectedTransactionId,
  transaction,
}: AnnotationHandlers & { transaction: FinanceTransaction }) {
  const expanded = selectedTransactionId === transaction.id;
  const formId = `annotation-${transaction.id}`;
  return (
    <li className="row financeTransaction">
      <time
        className="financeTransactionDate"
        dateTime={transaction.transactionDate}
      >
        {formatDate(transaction.transactionDate)}
      </time>
      <div className="rowMain financeTransactionMain">
        <span className="rowTitle financeTransactionName">
          {transaction.merchantName ?? transaction.name}
        </span>
        <span className="rowMeta financeTransactionMeta">
          {transaction.accountName} · {category(transaction)}
        </span>
      </div>
      <div className="cluster financeTransactionStatus">
        {transaction.pending && <Badge tone="warning">Pending</Badge>}
        {transaction.annotation.reviewed && (
          <Badge tone="success">Reviewed</Badge>
        )}
      </div>
      <span
        className={cx(
          "financeAmount",
          transaction.amount < 0 && "financeAmountCredit",
        )}
      >
        {formatMoney(-transaction.amount, transaction.currencyCode)}
      </span>
      <Button
        aria-controls={expanded ? formId : undefined}
        aria-expanded={expanded}
        className="financeTransactionAction"
        icon="edit"
        onClick={() => onSelectAnnotation(transaction.id)}
        size="sm"
        variant="ghost"
      >
        {hasAnnotation(transaction) ? "Edit note" : "Annotate"}
      </Button>
      {expanded && (
        <TransactionAnnotationForm
          busy={busy}
          id={formId}
          key={transaction.id}
          onClose={() => onSelectAnnotation(transaction.id)}
          onSave={(input) => onAnnotate(transaction, input)}
          transaction={transaction}
        />
      )}
    </li>
  );
}

function TransactionAnnotationForm({
  busy,
  id,
  onClose,
  onSave,
  transaction,
}: {
  busy: boolean;
  id: string;
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
      aria-label={`Annotation for ${transaction.merchantName ?? transaction.name}`}
      className="financeAnnotation"
      id={id}
      onSubmit={(event) => void submit(event)}
    >
      <div className="financeAnnotationHeader">
        <p className="eyebrow">Transaction annotation</p>
        <Button icon="close" onClick={onClose} size="sm" variant="ghost">
          Close
        </Button>
      </div>
      <div className="formGrid">
        <div className="formRow">
          <Field label="Category override">
            <input
              className="input"
              maxLength={100}
              onChange={(event) => setCategoryOverride(event.target.value)}
              placeholder={formatLabel(
                transaction.categoryPrimary ?? "Uncategorized",
              )}
              value={categoryOverride}
            />
          </Field>
          <Field label="Labels">
            <input
              className="input"
              onChange={(event) => setLabels(event.target.value)}
              placeholder="tax, travel, follow up"
              value={labels}
            />
          </Field>
        </div>
        <Field label="Note">
          <textarea
            className="textarea"
            maxLength={2000}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Add context to this transaction…"
            rows={3}
            value={note}
          />
        </Field>
      </div>
      <div className="financeAnnotationFooter">
        <label className="check">
          <input
            checked={reviewed}
            onChange={(event) => setReviewed(event.target.checked)}
            type="checkbox"
          />
          Reviewed
        </label>
        <Button busy={saving} disabled={busy} type="submit" variant="primary">
          {saving ? "Saving…" : "Save annotation"}
        </Button>
      </div>
    </form>
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
  return formatLabel(
    transaction.annotation.categoryOverride ??
      transaction.categoryPrimary ??
      "Uncategorized",
  );
}

function connectionTone(status: string): BadgeTone {
  if (status === "active") return "success";
  if (status === "error") return "danger";
  return "neutral";
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
