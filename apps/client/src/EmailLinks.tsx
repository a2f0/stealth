import { Banner, Button, cx, Icon } from "@tearleads/ui/react";
import { type FormEvent, useEffect, useState } from "react";
import {
  type InboundEmailLink,
  type InboundEmailLinkTarget,
  type LibraryFolder,
  linkInboundEmail,
  listLibraryFolders,
  unlinkInboundEmail,
} from "./api";
import {
  type FinanceTransactionMatch,
  searchFinanceTransactions,
} from "./financeApi";
import { formatMoney } from "./financeFormat";
import { handleNavigation, libraryPath } from "./workspacePaths";

type LinkTab = "folder" | "transaction";

/**
 * The folders and transactions an email is linked to, with controls to add
 * and remove links while the email is outside Trash.
 */
export function EmailLinks({
  canAccessFinance,
  editable,
  emailId,
  links,
  onChange,
  onNavigate,
}: {
  canAccessFinance: boolean;
  editable: boolean;
  emailId: string;
  links: InboundEmailLink[];
  /** Receives an update so results that finish out of order compose. */
  onChange: (update: (links: InboundEmailLink[]) => InboundEmailLink[]) => void;
  onNavigate: (pathname: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [workingId, setWorkingId] = useState<string>();
  const [error, setError] = useState<string>();

  async function link(target: InboundEmailLinkTarget) {
    setError(undefined);
    try {
      const created = await linkInboundEmail(emailId, target);
      onChange((current) => [
        ...current.filter(({ id }) => id !== created.id),
        created,
      ]);
      setAdding(false);
    } catch (cause) {
      setError(messageFrom(cause));
    }
  }

  async function unlink(link: InboundEmailLink) {
    setWorkingId(link.id);
    setError(undefined);
    try {
      await unlinkInboundEmail(emailId, link.id);
      onChange((current) => current.filter(({ id }) => id !== link.id));
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setWorkingId(undefined);
    }
  }

  if (!editable && links.length === 0) return null;
  return (
    <section aria-label="Links" className="emailLinks">
      <div className="emailLinksHeader">
        <h3 className="emailLinksTitle">
          <Icon name="link" size={16} />
          Linked to
        </h3>
        {editable && !adding && (
          <Button
            icon="add"
            onClick={() => setAdding(true)}
            size="sm"
            variant="ghost"
          >
            Link
          </Button>
        )}
      </div>
      {error && <Banner tone="danger">{error}</Banner>}
      {links.length > 0 ? (
        <ul className="emailLinkList">
          {links.map((link) => (
            <EmailLinkChip
              disabled={Boolean(workingId)}
              editable={editable}
              key={link.id}
              link={link}
              onNavigate={onNavigate}
              onUnlink={() => void unlink(link)}
              working={workingId === link.id}
            />
          ))}
        </ul>
      ) : (
        !adding && (
          <p className="emailLinksEmpty">
            Link this email to a library folder
            {canAccessFinance ? " or a finance transaction" : ""} to keep it
            with related records.
          </p>
        )
      )}
      {adding && (
        <AddLinkPanel
          canAccessFinance={canAccessFinance}
          links={links}
          onCancel={() => setAdding(false)}
          onLink={link}
          onNavigate={onNavigate}
        />
      )}
    </section>
  );
}

function EmailLinkChip({
  disabled,
  editable,
  link,
  onNavigate,
  onUnlink,
  working,
}: {
  /** One unlink at a time, so each chip's busy state stays accurate. */
  disabled: boolean;
  editable: boolean;
  link: InboundEmailLink;
  onNavigate: (pathname: string) => void;
  onUnlink: () => void;
  working: boolean;
}) {
  const folder = link.targetType === "library_folder";
  const label = folder
    ? link.folder.name
    : `${link.transaction.merchantName ?? link.transaction.name} · ${formatMoney(-link.transaction.amount, link.transaction.currencyCode)} · ${formatDate(link.transaction.date)}`;
  const path = folder ? libraryPath(link.targetId) : "/finance";
  return (
    <li className="emailLinkChip">
      <a
        className="emailLinkTarget"
        href={path}
        onClick={(event) => handleNavigation(event, path, onNavigate)}
      >
        <Icon name={folder ? "folder" : "finance"} size={16} />
        <span className="emailLinkLabel">{label}</span>
      </a>
      {editable && (
        <Button
          aria-label={`Unlink ${label}`}
          busy={working}
          className="emailLinkRemove"
          disabled={disabled}
          icon="close"
          iconOnly
          onClick={onUnlink}
          size="sm"
          variant="ghost"
        />
      )}
    </li>
  );
}

function AddLinkPanel({
  canAccessFinance,
  links,
  onCancel,
  onLink,
  onNavigate,
}: {
  canAccessFinance: boolean;
  links: InboundEmailLink[];
  onCancel: () => void;
  onLink: (target: InboundEmailLinkTarget) => Promise<void>;
  onNavigate: (pathname: string) => void;
}) {
  const [tab, setTab] = useState<LinkTab>("folder");
  const linkedIds = new Set(links.map(({ targetId }) => targetId));
  return (
    <div className="emailLinkPanel">
      <div className="emailLinkPanelHeader">
        {canAccessFinance ? (
          <nav aria-label="Link to" className="segmented">
            <button
              aria-pressed={tab === "folder"}
              onClick={() => setTab("folder")}
              type="button"
            >
              <Icon name="folder" size={16} />
              Library folder
            </button>
            <button
              aria-pressed={tab === "transaction"}
              onClick={() => setTab("transaction")}
              type="button"
            >
              <Icon name="finance" size={16} />
              Transaction
            </button>
          </nav>
        ) : (
          <p className="eyebrow">Link to a library folder</p>
        )}
        <Button icon="close" onClick={onCancel} size="sm" variant="ghost">
          Cancel
        </Button>
      </div>
      {tab === "folder" ? (
        <FolderPicker
          linkedIds={linkedIds}
          onLink={onLink}
          onNavigate={onNavigate}
        />
      ) : (
        <TransactionPicker linkedIds={linkedIds} onLink={onLink} />
      )}
    </div>
  );
}

function FolderPicker({
  linkedIds,
  onLink,
  onNavigate,
}: {
  linkedIds: Set<string>;
  onLink: (target: InboundEmailLinkTarget) => Promise<void>;
  onNavigate: (pathname: string) => void;
}) {
  const [folders, setFolders] = useState<LibraryFolder[]>();
  const [folderId, setFolderId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    listLibraryFolders()
      .then(setFolders)
      .catch((cause: unknown) => setError(messageFrom(cause)));
  }, []);
  const available = folders?.filter(({ id }) => !linkedIds.has(id)) ?? [];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!folderId) return;
    setSaving(true);
    await onLink({ targetId: folderId, targetType: "library_folder" });
    setSaving(false);
  }

  if (error) return <p className="fieldError">{error}</p>;
  if (!folders) return <p className="emailLinksEmpty">Loading folders…</p>;
  if (available.length === 0) {
    return (
      <div className="emailLinkPickerEmpty">
        <p className="emailLinksEmpty">
          {folders.length
            ? "This email is already linked to every folder."
            : "Your library doesn’t have any folders yet."}
        </p>
        <Button
          icon="folderAdd"
          onClick={() => onNavigate(libraryPath())}
          size="sm"
        >
          Open the Library
        </Button>
      </div>
    );
  }
  return (
    <form
      className="emailLinkFolderForm"
      onSubmit={(event) => void submit(event)}
    >
      <select
        aria-label="Folder"
        className="select inputSm"
        onChange={(event) => setFolderId(event.target.value)}
        value={folderId}
      >
        <option value="">Choose a folder…</option>
        {available.map((folder) => (
          <option key={folder.id} value={folder.id}>
            {folder.name}
          </option>
        ))}
      </select>
      <Button
        busy={saving}
        disabled={!folderId}
        icon="link"
        size="sm"
        type="submit"
        variant="primary"
      >
        Link
      </Button>
    </form>
  );
}

function TransactionPicker({
  linkedIds,
  onLink,
}: {
  linkedIds: Set<string>;
  onLink: (target: InboundEmailLinkTarget) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<FinanceTransactionMatch[]>();
  const [savingId, setSavingId] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      searchFinanceTransactions(query)
        .then((results) => {
          if (!active) return;
          setError(undefined);
          setMatches(results);
        })
        .catch((cause: unknown) => {
          if (active) setError(messageFrom(cause));
        });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  async function choose(transaction: FinanceTransactionMatch) {
    setSavingId(transaction.id);
    await onLink({
      targetId: transaction.id,
      targetType: "finance_transaction",
    });
    setSavingId(undefined);
  }

  return (
    <div className="emailLinkTransactions">
      <input
        aria-label="Search transactions"
        className="input inputSm"
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search by merchant, name, or amount"
        type="search"
        value={query}
      />
      {error && <p className="fieldError">{error}</p>}
      {matches && matches.length === 0 && (
        <p className="emailLinksEmpty">No matching transactions.</p>
      )}
      {matches && matches.length > 0 && (
        <ul className="rowList emailLinkMatches">
          {matches.map((transaction) => {
            const linked = linkedIds.has(transaction.id);
            return (
              <li key={transaction.id}>
                <button
                  className={cx(
                    "row emailLinkMatch",
                    linked && "emailLinkMatchLinked",
                  )}
                  disabled={linked || Boolean(savingId)}
                  onClick={() => void choose(transaction)}
                  type="button"
                >
                  <span className="emailLinkMatchDate">
                    {formatDate(transaction.transactionDate)}
                  </span>
                  <span className="rowMain">
                    <span className="rowTitle truncate">
                      {transaction.merchantName ?? transaction.name}
                    </span>
                    <span className="rowMeta truncate">
                      {linked ? "Already linked" : transaction.accountName}
                    </span>
                  </span>
                  <span className="emailLinkMatchAmount">
                    {savingId === transaction.id ? (
                      <span aria-hidden="true" className="spinner" />
                    ) : (
                      formatMoney(-transaction.amount, transaction.currencyCode)
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(`${value}T12:00:00`));
}

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not update links.";
}
