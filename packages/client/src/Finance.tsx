import {
  Avatar,
  Badge,
  type BadgeTone,
  Banner,
  Button,
  ButtonLink,
  Card,
  confirmDialog,
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
import type { LinkedEmail } from "./api";
import { websiteUrl } from "./config";
import { FinanceCategories } from "./FinanceCategories";
import { FinanceReports } from "./FinanceReports";
import {
  createPlaidLinkToken,
  deleteFinanceConnectionData,
  disconnectFinanceConnection,
  type ExpenseCategory,
  exchangePlaidPublicToken,
  type FinanceAccount,
  type FinanceConnection,
  type FinanceData,
  type FinanceTransaction,
  type FinanceTransactionAnnotationInput,
  getFinanceData,
  setTransactionCategory,
  syncFinanceConnection,
  updateFinanceTransactionAnnotation,
} from "./financeApi";
import { formatMoney } from "./financeFormat";
import { type FinancePage, financePageFor, financePages } from "./financePages";
import { filterTransactionsByAccount } from "./financeTransactions";
import { countLabel, formatLabel } from "./labels";
import { handleNavigation, inboxEmailPath } from "./workspacePaths";

const linkTokenStorageKey = "tearleads.plaid.linkToken";

export function Finance({
  onNavigate,
  pathname,
}: {
  onNavigate: (pathname: string) => void;
  pathname: string;
}) {
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
      onAnnotate={actions.annotate}
      onCategorize={categorizeTransaction(setData, setError)}
      onConnect={plaid.connect}
      onDeleteData={actions.deleteData}
      onDisconnect={actions.disconnect}
      onNavigate={onNavigate}
      onReload={load}
      onSync={actions.sync}
      page={financePageFor(pathname)}
    />
  );
}

/**
 * Assigns a transaction's single expense category right away, updating the
 * list and category counts optimistically and restoring them on failure.
 */
function categorizeTransaction(
  setData: Dispatch<SetStateAction<FinanceData | undefined>>,
  setError: Dispatch<SetStateAction<string | undefined>>,
) {
  return async (transaction: FinanceTransaction, categoryId: string | null) => {
    const previous = transaction.expenseCategoryId;
    if (previous === categoryId) return;
    setError(undefined);
    setData((current) =>
      withCategory(current, transaction.id, previous, categoryId),
    );
    try {
      await setTransactionCategory(transaction.id, categoryId);
    } catch (cause) {
      setData((current) =>
        withCategory(current, transaction.id, categoryId, previous),
      );
      setError(messageFrom(cause));
    }
  };
}

function withCategory(
  data: FinanceData | undefined,
  transactionId: string,
  from: string | null,
  to: string | null,
): FinanceData | undefined {
  if (!data) return data;
  return {
    ...data,
    categories: data.categories.map((category) => {
      const change =
        (category.id === to ? 1 : 0) - (category.id === from ? 1 : 0);
      return change
        ? { ...category, transactionCount: category.transactionCount + change }
        : category;
    }),
    transactions: data.transactions.map((transaction) =>
      transaction.id === transactionId
        ? { ...transaction, expenseCategoryId: to }
        : transaction,
    ),
  };
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
      if (await confirmDataDeletion(connection)) {
        await run(async () => {
          await deleteFinanceConnectionData(connection.id);
          return "Imported bank data permanently deleted.";
        });
      }
    },
    disconnect: async (connection: FinanceConnection) => {
      if (await confirmDisconnect(connection)) {
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

interface OverviewHandlers {
  busy: boolean;
  onAnnotate: (
    transaction: FinanceTransaction,
    input: FinanceTransactionAnnotationInput,
  ) => Promise<void>;
  onCategorize: (
    transaction: FinanceTransaction,
    categoryId: string | null,
  ) => Promise<void>;
  onConnect: () => Promise<void>;
  onDeleteData: (connection: FinanceConnection) => Promise<void>;
  onDisconnect: (connection: FinanceConnection) => Promise<void>;
  onNavigate: (pathname: string) => void;
  onSync: (id: string) => Promise<void>;
}

export function FinanceView({
  data,
  error,
  notice,
  onReload,
  page,
  ...handlers
}: OverviewHandlers & {
  data: FinanceData | undefined;
  error: string | undefined;
  notice: string | undefined;
  onReload: () => Promise<void>;
  page: FinancePage;
}) {
  const unconfigured = data?.configured === false;
  return (
    <Page>
      <FinanceHeader
        busy={handlers.busy}
        onConnect={handlers.onConnect}
        onNavigate={handlers.onNavigate}
        page={page}
        unconfigured={unconfigured}
      />
      <PageBody>
        <FinanceNotices
          error={error}
          notice={notice}
          overview={page === "overview"}
          showDataNotice={data?.accounts.length === 0}
          unconfigured={unconfigured}
        />
        {page === "reports" && (
          <FinanceReports onNavigate={handlers.onNavigate} />
        )}
        {page === "categories" && (
          <FinanceCategories
            categories={data?.categories}
            onChanged={onReload}
          />
        )}
        {page === "overview" && <FinanceOverview data={data} {...handlers} />}
      </PageBody>
    </Page>
  );
}

function FinanceOverview({
  data,
  ...handlers
}: OverviewHandlers & { data: FinanceData | undefined }) {
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
      <Connections
        busy={handlers.busy}
        connections={data?.connections}
        onConnect={handlers.onConnect}
        onDeleteData={handlers.onDeleteData}
        onDisconnect={handlers.onDisconnect}
        onSync={handlers.onSync}
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
        busy={handlers.busy}
        categories={data?.categories ?? []}
        onAnnotate={handlers.onAnnotate}
        onCategorize={handlers.onCategorize}
        onClearFilter={() => setSelectedAccountId(undefined)}
        onNavigate={handlers.onNavigate}
        onSelectAnnotation={(transactionId) =>
          setSelectedTransactionId((current) =>
            current === transactionId ? undefined : transactionId,
          )
        }
        selectedTransactionId={selectedTransactionId}
        transactions={transactions}
      />
    </>
  );
}

function FinanceHeader({
  busy,
  onConnect,
  onNavigate,
  page,
  unconfigured,
}: {
  busy: boolean;
  onConnect: () => Promise<void>;
  onNavigate: (pathname: string) => void;
  page: FinancePage;
  unconfigured: boolean;
}) {
  return (
    <PageHeader
      actions={
        page === "overview" && (
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
        )
      }
      description="Balances and transactions from your connected institutions, ready for your team to review, categorize, and report on."
      eyebrow="Connected accounts"
      tabs={financePages.map((item) => (
        <a
          aria-current={page === item.page ? "page" : undefined}
          className="tab"
          href={item.path}
          key={item.path}
          onClick={(event) => handleNavigation(event, item.path, onNavigate)}
        >
          {item.label}
        </a>
      ))}
      tabsLabel="Finance sections"
      title="Finance"
    />
  );
}

function FinanceNotices({
  error,
  notice,
  overview,
  showDataNotice,
  unconfigured,
}: {
  error: string | undefined;
  notice: string | undefined;
  /** Setup and data-handling notices belong with the connections. */
  overview: boolean;
  showDataNotice: boolean;
  unconfigured: boolean;
}) {
  if (!error && !notice && !(overview && (unconfigured || showDataNotice)))
    return null;
  return (
    <div className="stack stackMd">
      {error && <Banner tone="danger">{error}</Banner>}
      {notice && <Banner tone="success">{notice}</Banner>}
      {overview && unconfigured && <FinanceSetupNotice />}
      {overview && showDataNotice && <FinanceDataNotice />}
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
      await launchPlaid(result.linkToken, undefined, complete, (message) => {
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
    void launchPlaid(token, window.location.href, complete, (message) => {
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
  categories: ExpenseCategory[];
  onNavigate: (pathname: string) => void;
  onAnnotate: (
    transaction: FinanceTransaction,
    input: FinanceTransactionAnnotationInput,
  ) => Promise<void>;
  onCategorize: (
    transaction: FinanceTransaction,
    categoryId: string | null,
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
      {Boolean(transactions?.length) && !handlers.categories.length && (
        <Banner
          actions={
            <Button
              onClick={() => handlers.onNavigate("/finance/categories")}
              size="sm"
            >
              Set up categories
            </Button>
          }
          announce={false}
          icon="layers"
          title="Sort spending into expense categories"
        >
          Give each transaction a category to see totals by category in Reports.
        </Banner>
      )}
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
  categories,
  onAnnotate,
  onCategorize,
  onNavigate,
  onSelectAnnotation,
  selectedTransactionId,
  transaction,
}: AnnotationHandlers & { transaction: FinanceTransaction }) {
  const expanded = selectedTransactionId === transaction.id;
  const formId = `annotation-${transaction.id}`;
  const title = transaction.merchantName ?? transaction.name;
  return (
    <li className="row financeTransaction">
      <time
        className="financeTransactionDate"
        dateTime={transaction.transactionDate}
      >
        {formatDate(transaction.transactionDate)}
      </time>
      <div className="rowMain financeTransactionMain">
        <span className="rowTitle financeTransactionName">{title}</span>
        <span className="rowMeta financeTransactionMeta">
          {transactionMeta(transaction)}
        </span>
        <LinkedEmailChips
          emails={transaction.linkedEmails}
          onNavigate={onNavigate}
        />
      </div>
      <div className="financeTransactionCategory">
        {categories.length > 0 && (
          <select
            aria-label={`Expense category for ${title}`}
            className={cx(
              "select inputSm",
              !transaction.expenseCategoryId && "financeCategoryUnset",
            )}
            onChange={(event) =>
              void onCategorize(transaction, event.target.value || null)
            }
            value={transaction.expenseCategoryId ?? ""}
          >
            <option value="">Uncategorized</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        )}
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

/** Inbox emails, such as receipts, linked to a transaction. */
function LinkedEmailChips({
  emails,
  onNavigate,
}: {
  emails: LinkedEmail[];
  onNavigate: (pathname: string) => void;
}) {
  if (!emails.length) return null;
  return (
    <span className="financeTransactionEmails">
      {emails.map((email) => {
        const path = inboxEmailPath(email.id);
        return (
          <a
            className="financeEmailChip"
            href={path}
            key={email.linkId}
            onClick={(event) => handleNavigation(event, path, onNavigate)}
          >
            <Icon name="mail" size={14} />
            <span className="truncate">{email.subject || "(no subject)"}</span>
          </a>
        );
      })}
    </span>
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
        <Field label="Labels">
          <input
            className="input"
            onChange={(event) => setLabels(event.target.value)}
            placeholder="tax, travel, follow up"
            value={labels}
          />
        </Field>
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

let plaidScript: Promise<boolean> | undefined;

/**
 * Loads Plaid Link on first use rather than on every page, so its script
 * never runs on pages that carry secrets in the URL, such as signing links.
 */
function loadPlaid() {
  plaidScript ??= new Promise<boolean>((resolve) => {
    if (window.Plaid) return resolve(true);
    const script = document.createElement("script");
    script.async = true;
    script.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
    script.onload = () => resolve(Boolean(window.Plaid));
    script.onerror = () => {
      plaidScript = undefined;
      script.remove();
      resolve(false);
    };
    document.head.append(script);
  });
  return plaidScript;
}

async function launchPlaid(
  token: string,
  receivedRedirectUri: string | undefined,
  onSuccess: (token: string, metadata: PlaidLinkMetadata) => Promise<void>,
  onExit: (message: string | undefined) => void,
) {
  if (!(await loadPlaid()) || !window.Plaid) {
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
  if (hasOAuthState())
    window.history.replaceState(window.history.state, "", "/finance");
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

/** The account, plus the bank's own category as context when it has one. */
function transactionMeta(transaction: FinanceTransaction) {
  return transaction.categoryPrimary
    ? `${transaction.accountName} · ${formatLabel(transaction.categoryPrimary)}`
    : transaction.accountName;
}

function connectionTone(status: string): BadgeTone {
  if (status === "active") return "success";
  if (status === "error") return "danger";
  return "neutral";
}

function hasAnnotation(transaction: FinanceTransaction) {
  const annotation = transaction.annotation;
  return Boolean(
    annotation.note || annotation.labels.length || annotation.reviewed,
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
  }).format(new Date(`${value}T12:00:00`));
}

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not update finances.";
}

function institutionName(connection: FinanceConnection) {
  return connection.institutionName ?? "this institution";
}

function confirmDataDeletion(connection: FinanceConnection) {
  return confirmDialog({
    confirmLabel: "Delete data",
    message:
      "This also deletes its transaction annotations and cannot be undone.",
    title: `Permanently delete all imported data for ${institutionName(connection)}?`,
    tone: "danger",
  });
}

function confirmDisconnect(connection: FinanceConnection) {
  return confirmDialog({
    confirmLabel: "Disconnect",
    message:
      "Plaid access will be revoked, but imported transactions and annotations will remain.",
    title: `Disconnect ${institutionName(connection)}?`,
    tone: "danger",
  });
}
