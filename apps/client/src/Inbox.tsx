import {
  Banner,
  Button,
  cx,
  EmptyState,
  Icon,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
} from "@tearleads/ui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AttachmentPreviewTile } from "./AttachmentPreview";
import {
  deleteInboundEmail,
  getInboundEmail,
  type InboundEmailDetail,
  type InboundEmailLink,
  type InboundEmailSummary,
  type InboxFolder,
  inboundAttachmentUrl,
  listInboundEmails,
  restoreInboundEmail,
} from "./api";
import { EmailLinks } from "./EmailLinks";
import { countLabel, formatBytes } from "./labels";
import { previewKindFor } from "./previewKind";

interface InboxContext {
  canAccessFinance: boolean;
  onNavigate: (pathname: string) => void;
}

export function Inbox(context: InboxContext) {
  return <InboxView context={context} model={useInboxModel()} />;
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
  const requestedId = useRequestedEmailId();

  const refresh = useCallback(async () => {
    setLoadingList(true);
    setError(undefined);
    try {
      const listing = await listInboundEmails(folder);
      const nextEmails = listing.emails;
      const requested = requestedId.current;
      requestedId.current = undefined;
      setEmails(nextEmails);
      setInboundAddress(listing.address);
      setSelectedId((current) => {
        const preferred = requested ?? current;
        return nextEmails.some(({ id }) => id === preferred)
          ? preferred
          : nextEmails[0]?.id;
      });
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setLoadingList(false);
    }
  }, [folder, requestedId]);

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

/**
 * The message named by `?email=`, consumed by the first listing. The query is
 * removed so later reloads open the inbox normally.
 */
function useRequestedEmailId() {
  const requested = useRef<string | undefined>(undefined);
  const initialized = useRef(false);
  if (!initialized.current) {
    initialized.current = true;
    requested.current =
      new URLSearchParams(window.location.search).get("email") ?? undefined;
  }
  useEffect(() => {
    if (window.location.search) {
      window.history.replaceState(window.history.state, "", "/inbox");
    }
  }, []);
  return requested;
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

type InboxMessages = ReturnType<typeof useInboxMessages>;
type InboxActions = ReturnType<typeof useInboxActions>;

function InboxView({
  context,
  model,
}: {
  context: InboxContext;
  model: ReturnType<typeof useInboxModel>;
}) {
  const { actions, folder, messages, selectFolder } = model;
  const error = actions.error ?? messages.error;
  return (
    <Page>
      <InboxHeader
        folder={folder}
        loading={messages.loadingList}
        onRefresh={messages.refresh}
      />
      <PageBody>
        {error && <Banner tone="danger">{error}</Banner>}
        {actions.notice && <Banner tone="success">{actions.notice}</Banner>}
        <div className="stack">
          <InboxToolbar
            address={messages.inboundAddress}
            folder={folder}
            onSelect={selectFolder}
          />
          {folder === "trash" && (
            <Banner announce={false} icon="trash" tone="neutral">
              Deleted messages are permanently removed after 30 days.
            </Banner>
          )}
          <InboxPanes
            actions={actions}
            context={context}
            folder={folder}
            messages={messages}
          />
        </div>
      </PageBody>
    </Page>
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
    <PageHeader
      actions={
        <Button busy={loading} icon="refresh" onClick={() => void onRefresh()}>
          {loading ? "Loading…" : "Refresh"}
        </Button>
      }
      description="Messages and attachments sent to your organization’s inbound address."
      eyebrow="Organization inbox"
      title={folder === "trash" ? "Trash" : "Inbox"}
    />
  );
}

function InboxToolbar({
  address,
  folder,
  onSelect,
}: {
  address: string | undefined;
  folder: InboxFolder;
  onSelect: (folder: InboxFolder) => void;
}) {
  return (
    <div className="inboxToolbar">
      <nav aria-label="Email folders" className="segmented inboxFolders">
        {(["inbox", "trash"] as const).map((availableFolder) => (
          <button
            aria-pressed={folder === availableFolder}
            key={availableFolder}
            onClick={() => onSelect(availableFolder)}
            type="button"
          >
            <Icon name={availableFolder} size={16} />
            {availableFolder === "inbox" ? "Inbox" : "Trash"}
          </button>
        ))}
      </nav>
      {address && (
        <p className="inboxAddress">
          <span className="inboxAddressLabel">
            <Icon name="mail" size={16} />
            Send inbound email to
          </span>
          <code className="codeChip inboxAddressValue">{address}</code>
        </p>
      )}
    </div>
  );
}

function InboxPanes({
  actions,
  context,
  folder,
  messages,
}: {
  actions: InboxActions;
  context: InboxContext;
  folder: InboxFolder;
  messages: InboxMessages;
}) {
  if (messages.emails.length === 0) {
    if (messages.loadingList) {
      return (
        <div className="card">
          <LoadingState label="Loading messages…" />
        </div>
      );
    }
    return <InboxEmptyState folder={folder} />;
  }
  return (
    <div className="card inboxLayout">
      <MessageList
        emails={messages.emails}
        folder={folder}
        onSelect={messages.setSelectedId}
        selectedId={messages.selectedId}
      />
      <MessageDetail
        context={context}
        email={messages.detail}
        folder={folder}
        loading={messages.loadingMessage}
        onDelete={actions.moveToTrash}
        onLinksChange={(links) =>
          messages.setDetail((current) =>
            current ? { ...current, links } : current,
          )
        }
        onRestore={actions.restore}
        unavailable={Boolean(messages.error && messages.selectedId)}
        working={messages.detail?.id === actions.workingId}
      />
    </div>
  );
}

function InboxEmptyState({ folder }: { folder: InboxFolder }) {
  const trash = folder === "trash";
  return (
    <EmptyState
      icon={trash ? "trash" : "inbox"}
      title={trash ? "Trash is empty" : "No messages yet"}
    >
      {trash
        ? "Deleted messages will appear here."
        : "New messages will appear here."}
    </EmptyState>
  );
}

function MessageList({
  emails,
  folder,
  onSelect,
  selectedId,
}: {
  emails: InboundEmailSummary[];
  folder: InboxFolder;
  onSelect: (id: string) => void;
  selectedId?: string | undefined;
}) {
  return (
    <section aria-label={`${folder} messages`} className="rowList inboxList">
      {emails.map((email) => (
        <MessageListItem
          email={email}
          folder={folder}
          key={email.id}
          onSelect={onSelect}
          selected={selectedId === email.id}
        />
      ))}
    </section>
  );
}

function MessageListItem({
  email,
  folder,
  onSelect,
  selected,
}: {
  email: InboundEmailSummary;
  folder: InboxFolder;
  onSelect: (id: string) => void;
  selected: boolean;
}) {
  return (
    <button
      aria-pressed={selected}
      className="row inboxItem"
      onClick={() => onSelect(email.id)}
      type="button"
    >
      <span className="inboxItemHeading">
        <span
          className={cx(
            "rowTitle truncate",
            !email.subject && "inboxNoSubject",
          )}
        >
          {email.subject || "(no subject)"}
        </span>
        <span className="inboxItemDate">
          {folder === "trash" && email.deletedAt
            ? `Deleted ${formatDate(email.deletedAt)}`
            : formatDate(email.receivedAt)}
        </span>
      </span>
      <span className="rowMeta truncate">{email.from}</span>
      {email.attachmentCount > 0 && (
        <span className="inboxItemAttachments">
          <Icon name="attachment" size={14} />
          {countLabel(email.attachmentCount, "file")}
        </span>
      )}
    </button>
  );
}

function MessageDetail({
  context,
  email,
  folder,
  loading,
  onDelete,
  onLinksChange,
  onRestore,
  unavailable,
  working,
}: {
  context: InboxContext;
  email?: InboundEmailDetail | undefined;
  folder: InboxFolder;
  loading: boolean;
  onDelete: (email: InboundEmailDetail) => Promise<void>;
  onLinksChange: (links: InboundEmailLink[]) => void;
  onRestore: (email: InboundEmailDetail) => Promise<void>;
  unavailable: boolean;
  working: boolean;
}) {
  if (!email) {
    return (
      <MessageDetailPlaceholder loading={loading} unavailable={unavailable} />
    );
  }

  return (
    <article className="inboxDetail">
      <header className="inboxMessageHeader">
        <div className="inboxMessageTitle">
          <h2
            className={cx("inboxSubject", !email.subject && "inboxNoSubject")}
          >
            {email.subject || "(no subject)"}
          </h2>
          <MessageAction
            email={email}
            folder={folder}
            onDelete={onDelete}
            onRestore={onRestore}
            working={working}
          />
        </div>
        {email.deletedAt && (
          <Banner announce={false} icon="trash" tone="warning">
            Deleted {formatDateTime(email.deletedAt)} by {deletedBy(email)}
          </Banner>
        )}
        <dl className="keyValue inboxMeta">
          <dt>From</dt>
          <dd>{email.from}</dd>
          <dt>To</dt>
          <dd>{email.to}</dd>
          <dt>Received</dt>
          <dd>{formatDateTime(email.receivedAt)}</dd>
        </dl>
        <EmailLinks
          canAccessFinance={context.canAccessFinance}
          editable={folder === "inbox"}
          emailId={email.id}
          key={email.id}
          links={email.links}
          onChange={onLinksChange}
          onNavigate={context.onNavigate}
        />
      </header>
      <pre className="inboxBody">{readableBody(email)}</pre>
      {email.attachments.length > 0 && (
        <AttachmentList email={email} folder={folder} />
      )}
    </article>
  );
}

function MessageDetailPlaceholder({
  loading,
  unavailable,
}: {
  loading: boolean;
  unavailable: boolean;
}) {
  let placeholder = (
    <EmptyState compact icon="mail" plain title="Select a message" />
  );
  if (loading) {
    placeholder = <LoadingState label="Opening message…" />;
  } else if (unavailable) {
    placeholder = (
      <EmptyState
        compact
        icon="error"
        plain
        title="This message could not be opened"
      />
    );
  }
  return <div className="inboxDetail inboxDetailEmpty">{placeholder}</div>;
}

function MessageAction({
  email,
  folder,
  onDelete,
  onRestore,
  working,
}: {
  email: InboundEmailDetail;
  folder: InboxFolder;
  onDelete: (email: InboundEmailDetail) => Promise<void>;
  onRestore: (email: InboundEmailDetail) => Promise<void>;
  working: boolean;
}) {
  if (folder === "trash") {
    return (
      <Button
        busy={working}
        className="inboxMessageAction"
        icon="restore"
        onClick={() => void onRestore(email)}
        variant="primary"
      >
        {working ? "Restoring…" : "Restore"}
      </Button>
    );
  }
  return (
    <Button
      busy={working}
      className="inboxMessageAction"
      icon="trash"
      onClick={() => void onDelete(email)}
      variant="danger"
    >
      {working ? "Moving…" : "Move to Trash"}
    </Button>
  );
}

function AttachmentList({
  email,
  folder,
}: {
  email: InboundEmailDetail;
  folder: InboxFolder;
}) {
  const previews = email.attachments.flatMap((attachment) => {
    const kind = previewKindFor(attachment);
    return kind ? [{ attachment, kind }] : [];
  });
  const others = email.attachments.filter(
    (attachment) => !previewKindFor(attachment),
  );
  return (
    <section className="inboxAttachments">
      <h3 className="inboxAttachmentsTitle">
        Attachments
        <span className="sectionCount">{email.attachments.length}</span>
      </h3>
      {previews.length > 0 && (
        <div className="inboxPreviewGrid">
          {previews.map(({ attachment, kind }) => (
            <AttachmentPreviewTile
              attachment={attachment}
              key={attachment.id}
              kind={kind}
              url={inboundAttachmentUrl(email.id, attachment.id, folder)}
            />
          ))}
        </div>
      )}
      {others.length > 0 && (
        <AttachmentChips attachments={others} email={email} folder={folder} />
      )}
    </section>
  );
}

function AttachmentChips({
  attachments,
  email,
  folder,
}: {
  attachments: InboundEmailDetail["attachments"];
  email: InboundEmailDetail;
  folder: InboxFolder;
}) {
  return (
    <div className="inboxAttachmentList">
      {attachments.map((attachment) => (
        <a
          className="inboxAttachment"
          href={inboundAttachmentUrl(email.id, attachment.id, folder)}
          key={attachment.id}
        >
          <Icon name="attachment" size={16} />
          <span className="inboxAttachmentName">{attachment.filename}</span>
          <span className="inboxAttachmentSize">
            {formatBytes(attachment.size)}
          </span>
        </a>
      ))}
    </div>
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

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not load the inbox.";
}
