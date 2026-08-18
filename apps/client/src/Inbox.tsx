import { useCallback, useEffect, useState } from "react";
import {
  getInboundEmail,
  type InboundEmailDetail,
  type InboundEmailSummary,
  inboundAttachmentUrl,
  listInboundEmails,
} from "./api";

export function Inbox() {
  const [emails, setEmails] = useState<InboundEmailSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<InboundEmailDetail>();
  const [loadingList, setLoadingList] = useState(true);
  const [loadingMessage, setLoadingMessage] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    setLoadingList(true);
    setError(undefined);
    try {
      const nextEmails = await listInboundEmails();
      setEmails(nextEmails);
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
  }, []);

  useEffect(() => {
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
    getInboundEmail(selectedId)
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
  }, [selectedId]);

  return (
    <>
      <header className="topbar">
        <div>
          <p className="eyebrow">Administration</p>
          <h1>Inbox</h1>
        </div>
        <button
          className="primaryButton"
          disabled={loadingList}
          onClick={() => void refresh()}
          type="button"
        >
          {loadingList ? "Loading…" : "Refresh"}
        </button>
      </header>
      <section className="content inboxContent">
        {error && <div className="errorBanner">{error}</div>}
        <div className="inboxLayout">
          <MessageList
            emails={emails}
            loading={loadingList}
            onSelect={setSelectedId}
            selectedId={selectedId}
          />
          <MessageDetail
            email={detail}
            hasMessages={emails.length > 0}
            loading={loadingMessage}
          />
        </div>
      </section>
    </>
  );
}

function MessageList({
  emails,
  loading,
  onSelect,
  selectedId,
}: {
  emails: InboundEmailSummary[];
  loading: boolean;
  onSelect: (id: string) => void;
  selectedId?: string | undefined;
}) {
  if (emails.length === 0) {
    return (
      <div className="inboxListEmpty">
        {loading ? "Loading messages…" : "No messages yet."}
      </div>
    );
  }

  return (
    <section aria-label="Inbound messages" className="inboxList">
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
            {formatDate(email.receivedAt)}
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
  hasMessages,
  loading,
}: {
  email?: InboundEmailDetail | undefined;
  hasMessages: boolean;
  loading: boolean;
}) {
  if (!email) {
    return (
      <div className="inboxMessageEmpty">
        {loading ? "Opening message…" : emptyMessage(hasMessages)}
      </div>
    );
  }

  return (
    <article className="inboxMessage">
      <header className="inboxMessageHeader">
        <p className="eyebrow">{formatDateTime(email.receivedAt)}</p>
        <h2>{email.subject || "(no subject)"}</h2>
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
                href={inboundAttachmentUrl(email.id, attachment.id)}
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

function emptyMessage(hasMessages: boolean) {
  return hasMessages ? "Select a message." : "New messages will appear here.";
}

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not load the inbox.";
}
