import {
  Button,
  Card,
  EmptyState,
  Icon,
  PageSection,
} from "@tearleads/ui/react";
import type { LinkedEmail } from "./api";
import { countLabel } from "./labels";
import { handleNavigation, inboxEmailPath } from "./workspacePaths";

/**
 * Inbox messages linked to a record, each opening the message in the Inbox
 * and offering to remove the link.
 */
export function LinkedEmailList({
  busy,
  description,
  emails,
  emptyText,
  onNavigate,
  onUnlink,
  title = "Linked emails",
}: {
  busy: boolean;
  description: string;
  emails: LinkedEmail[];
  emptyText: string;
  onNavigate: (pathname: string) => void;
  onUnlink: (email: LinkedEmail) => void;
  title?: string;
}) {
  return (
    <PageSection
      actions={
        <span className="sectionCount">
          {countLabel(emails.length, "email")}
        </span>
      }
      description={description}
      title={title}
    >
      {emails.length === 0 ? (
        <EmptyState compact icon="mail" title="No linked emails">
          {emptyText}
        </EmptyState>
      ) : (
        <Card flush>
          <ul className="rowList">
            {emails.map((email) => {
              const path = inboxEmailPath(email.id);
              const subject = email.subject || "(no subject)";
              return (
                <li className="row linkedEmail" key={email.linkId}>
                  <Icon className="linkedEmailIcon" name="mail" />
                  <a
                    className="rowMain linkedEmailLink"
                    href={path}
                    onClick={(event) =>
                      handleNavigation(event, path, onNavigate)
                    }
                  >
                    <span className="rowTitle truncate">{subject}</span>
                    <span className="rowMeta truncate">
                      {email.from} · {formatDate(email.receivedAt)}
                      {email.attachmentCount > 0 &&
                        ` · ${countLabel(email.attachmentCount, "attachment")}`}
                    </span>
                  </a>
                  <div className="rowActions">
                    <Button
                      aria-label={`Unlink ${subject}`}
                      disabled={busy}
                      icon="unlink"
                      onClick={() => onUnlink(email)}
                      size="sm"
                      variant="ghost"
                    >
                      Unlink
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </PageSection>
  );
}

/** "Mar 3", or "Mar 3, 2024" for an earlier year, as older receipts often are. */
function formatDate(value: string) {
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === new Date().getFullYear()
      ? {}
      : { year: "numeric" }),
  }).format(date);
}
