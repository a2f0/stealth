import { useCallback, useEffect, useState } from "react";
import {
  deleteInboundEmail,
  getInboundEmail,
  type InboundEmailDetail,
  type InboundEmailSummary,
  type InboxFolder,
  inboundAttachmentUrl,
  listInboundEmails,
  restoreInboundEmail,
} from "./api";

export function Inbox() {
  return <InboxView model={useInboxModel()} />;
}

function useInboxModel() {
  const [folder, setFolder] = useState<InboxFolder>("inbox");
  const messages = useInboxMessages(folder);
  const actions = useInboxActions(messages);
  function selectFolder(nextFolder: InboxFolder) {
    if (nextFolder === folder) return;
    actions.clear();
    setFolder(nextFolder);
  }
  return { actions, folder, messages, selectFolder };
}

function useInboxMessages(folder: InboxFolder) {
  const [emails, setEmails] = useState<InboundEmailSummary[]>([]);
  const [inboundAddress, setInboundAddress] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<InboundEmailDetail>();
  const [loadingList, setLoadingList] = useState(true);
  const [loadingMessage, setLoadingMessage] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    setLoadingList(true);
    setError(undefined);
    try {
      const listing = await listInboundEmails(folder);
      const nextEmails = listing.emails;
      setEmails(nextEmails);
      setInboundAddress(listing.address);
      setSelectedId((current) =>
        nextEmails.some(({ id }) => id === current)
          ? current
          : nextEmails[0]?.id,
      );
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setLoadingList(false);
    }
  }, [folder]);

  useEffect(() => {
    setEmails([]);
    setSelectedId(undefined);
    setDetail(undefined);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(undefined);
      return;
    }
    let active = true;
    setError(undefined);
    setLoadingMessage(true);
    setDetail(undefined);
    getInboundEmail(selectedId, folder)
      .then((email) => {
        if (active) setDetail(email);
      })
      .catch((cause: unknown) => {
        if (active) setError(messageFrom(cause));
      })
      .finally(() => {
        if (active) setLoadingMessage(false);
      });
    return () => {
      active = false;
    };
  }, [folder, selectedId]);
  return {
    detail,
    emails,
    error,
    inboundAddress,
    loadingList,
    loadingMessage,
    refresh,
    selectedId,
    setDetail,
    setSelectedId,
  };
}

function useInboxActions(messages: ReturnType<typeof useInboxMessages>) {
  const [workingId, setWorkingId] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const clear = () => {
    setError(undefined);
    setNotice(undefined);
  };

  async function moveToTrash(email: InboundEmailDetail) {
    const subject = email.subject || "(no subject)";
    if (
      !window.confirm(
        `Move “${subject}” to Trash? It can be restored for 30 days.`,
      )
    ) {
      return;
    }
    await runAction(email.id, deleteInboundEmail, "Email moved to Trash.");
  }

  async function restore(email: InboundEmailDetail) {
    await runAction(email.id, restoreInboundEmail, "Email restored to Inbox.");
  }

  async function runAction(
    id: string,
    action: (emailId: string) => Promise<unknown>,
    successNotice: string,
  ) {
    setWorkingId(id);
    setError(undefined);
    setNotice(undefined);
    try {
      await action(id);
      messages.setSelectedId(undefined);
      messages.setDetail(undefined);
      setNotice(successNotice);
      await messages.refresh();
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setWorkingId(undefined);
    }
  }
  return { clear, error, moveToTrash, notice, restore, workingId };
}

function InboxView({ model }: { model: ReturnType<typeof useInboxModel> }) {
  const { actions, folder, messages, selectFolder } = model;
  return (
    <>
      <InboxHeader
        folder={folder}
        loading={messages.loadingList}
        onRefresh={messages.refresh}
      />
      <section className="content inboxContent">
        {(actions.error ?? messages.error) && (
          <div className="errorBanner pageBanner">
            {actions.error ?? messages.error}
          </div>
        )}
        {actions.notice && (
          <div className="successBanner pageBanner">{actions.notice}</div>
        )}
        <InboxFolderBar folder={folder} onSelect={selectFolder} />
        {messages.inboundAddress && (
          <div className="inboxAddress">
            <span>Send inbound email to</span>
            <code>{messages.inboundAddress}</code>
          </div>
        )}
        <div className="inboxLayout">
          <MessageList
            emails={messages.emails}
            folder={folder}
            loading={messages.loadingList}
            onSelect={messages.setSelectedId}
            selectedId={messages.selectedId}
          />
          <MessageDetail
            email={messages.detail}
            folder={folder}
            hasMessages={messages.emails.length > 0}
            loading={messages.loadingMessage}
            onDelete={actions.moveToTrash}
            onRestore={actions.restore}
            working={messages.detail?.id === actions.workingId}
          />
        </div>
      </section>
    </>
  );
}

function InboxHeader({
  folder,
  loading,
  onRefresh,
}: {
  folder: InboxFolder;
  loading: boolean;
  onRefresh: () => Promise<void>;
}) {
  return (
    <header className="topbar">
      <div>
        <p className="eyebrow">Organization inbox</p>
        <h1>{folder === "trash" ? "Trash" : "Inbox"}</h1>
      </div>
      <button
        className="primaryButton"
        disabled={loading}
        onClick={() => void onRefresh()}
        type="button"
      >
        {loading ? "Loading…" : "Refresh"}
      </button>
    </header>
  );
}

function InboxFolderBar({
  folder,
  onSelect,
}: {
  folder: InboxFolder;
  onSelect: (folder: InboxFolder) => void;
}) {
  return (
    <div className="inboxFolderBar">
      <nav aria-label="Email folders" className="inboxFolders">
        {(["inbox", "trash"] as const).map((availableFolder) => (
          <button
            aria-pressed={folder === availableFolder}
            key={availableFolder}
            onClick={() => onSelect(availableFolder)}
            type="button"
          >
            {availableFolder === "inbox" ? "Inbox" : "Trash"}
          </button>
        ))}
      </nav>
      {folder === "trash" && (
        <span>Deleted messages are permanently removed after 30 days.</span>
      )}
    </div>
  );
}

function MessageList({
  emails,
  folder,
  loading,
  onSelect,
  selectedId,
}: {
  emails: InboundEmailSummary[];
  folder: InboxFolder;
  loading: boolean;
  onSelect: (id: string) => void;
  selectedId?: string | undefined;
}) {
  if (emails.length === 0) {
    return (
      <div className="inboxListEmpty">
        {loading
          ? "Loading messages…"
          : folder === "trash"
            ? "Trash is empty."
            : "No messages yet."}
      </div>
    );
  }

  return (
    <section aria-label={`${folder} messages`} className="inboxList">
      {emails.map((email) => (
        <button
          aria-pressed={selectedId === email.id}
          className={selectedId === email.id ? "inboxItem active" : "inboxItem"}
          key={email.id}
          onClick={() => onSelect(email.id)}
          type="button"
        >
          <strong>{email.subject || "(no subject)"}</strong>
          <span>{email.from}</span>
          <small>
            {folder === "trash" && email.deletedAt
              ? `Deleted ${formatDate(email.deletedAt)}`
              : formatDate(email.receivedAt)}
            {email.attachmentCount > 0 &&
              ` · ${formatAttachmentCount(email.attachmentCount)}`}
          </small>
        </button>
      ))}
    </section>
  );
}

function MessageDetail({
  email,
  folder,
  hasMessages,
  loading,
  onDelete,
  onRestore,
  working,
}: {
  email?: InboundEmailDetail | undefined;
  folder: InboxFolder;
  hasMessages: boolean;
  loading: boolean;
  onDelete: (email: InboundEmailDetail) => Promise<void>;
  onRestore: (email: InboundEmailDetail) => Promise<void>;
  working: boolean;
}) {
  if (!email) {
    return (
      <div className="inboxMessageEmpty">
        {loading ? "Opening message…" : emptyMessage(hasMessages, folder)}
      </div>
    );
  }

  return (
    <article className="inboxMessage">
      <header className="inboxMessageHeader">
        <div className="inboxMessageTitle">
          <div>
            <p className="eyebrow">{formatDateTime(email.receivedAt)}</p>
            <h2>{email.subject || "(no subject)"}</h2>
          </div>
          {folder === "trash" ? (
            <button
              className="primaryButton inboxMessageAction"
              disabled={working}
              onClick={() => void onRestore(email)}
              type="button"
            >
              {working ? "Restoring…" : "Restore"}
            </button>
          ) : (
            <button
              className="dangerButton inboxMessageAction"
              disabled={working}
              onClick={() => void onDelete(email)}
              type="button"
            >
              {working ? "Moving…" : "Move to Trash"}
            </button>
          )}
        </div>
        {email.deletedAt && (
          <p className="emailDeletionMeta">
            Deleted {formatDateTime(email.deletedAt)} by {deletedBy(email)}
          </p>
        )}
        <dl className="emailMeta">
          <div>
            <dt>From</dt>
            <dd>{email.from}</dd>
          </div>
          <div>
            <dt>To</dt>
            <dd>{email.to}</dd>
          </div>
        </dl>
      </header>
      <pre className="emailBody">{readableBody(email)}</pre>
      {email.attachments.length > 0 && (
        <section className="attachmentSection">
          <h3>Attachments</h3>
          <div className="attachmentList">
            {email.attachments.map((attachment) => (
              <a
                className="attachmentLink"
                href={inboundAttachmentUrl(email.id, attachment.id, folder)}
                key={attachment.id}
              >
                <strong>{attachment.filename}</strong>
                <span>{formatBytes(attachment.size)}</span>
              </a>
            ))}
          </div>
        </section>
      )}
    </article>
  );
}

function readableBody(email: InboundEmailDetail) {
  if (email.text?.trim()) return email.text.trim();
  if (email.html) {
    const parsed = new DOMParser().parseFromString(email.html, "text/html");
    const text = parsed.body.textContent?.trim();
    if (text) return text;
  }
  return "This message has no readable body.";
}

function deletedBy(email: InboundEmailSummary) {
  return (
    email.deletedByName ??
    email.deletedByEmail ??
    email.deletedByUserId ??
    "an unknown user"
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
  }).format(new Date(value));
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatAttachmentCount(count: number) {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

function emptyMessage(hasMessages: boolean, folder: InboxFolder) {
  if (hasMessages) return "Select a message.";
  return folder === "trash"
    ? "Deleted messages will appear here."
    : "New messages will appear here.";
}

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not load the inbox.";
}
