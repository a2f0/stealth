import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  LoadingState,
  PageSection,
} from "@tearleads/ui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type ActivityEvent,
  type ActivityPage,
  type ActivitySource,
  listActivity,
} from "./activityApi";

const actionLabels: Record<string, string> = {
  "audit.answer_changed": "changed an answer",
  "audit.completed": "completed the audit",
  "audit.image_removed": "removed an image",
  "audit.image_uploaded": "attached an image",
  "audit.issue_assigned": "changed the issue assignee",
  "audit.issue_created": "raised an issue",
  "audit.issue_reopened": "reopened an issue",
  "audit.issue_resolved": "resolved an issue",
  "audit.reopened": "reopened the audit",
  "audit.started": "started the audit",
  "audit.template_created": "created the form",
  "audit.template_version_saved": "saved a form version",
};

export function ActivityFeed({
  compact = false,
  onNavigate,
  refreshKey,
  source,
}: {
  compact?: boolean;
  onNavigate?: (pathname: string) => void;
  refreshKey?: unknown;
  source?: ActivitySource;
}) {
  const { busy, error, loadMore, page, refresh } = useActivityPage(
    source,
    refreshKey,
  );
  return (
    <PageSection
      className={compact ? "activityFeedCompact" : undefined}
      actions={
        <Button onClick={refresh} size="sm">
          Refresh activity
        </Button>
      }
      title={compact ? "Recent activity" : "Activity"}
    >
      {error && <Banner tone="danger">{error}</Banner>}
      {page ? (
        <ActivityList
          compact={compact}
          events={page.events}
          onNavigate={source ? undefined : onNavigate}
        />
      ) : (
        !error && <LoadingState label="Loading activity…" />
      )}
      {page?.nextCursor && (
        <Button busy={busy} onClick={() => void loadMore()} size="sm">
          Load more activity
        </Button>
      )}
    </PageSection>
  );
}

function useActivityPage(source: ActivitySource, refreshKey: unknown) {
  const [page, setPage] = useState<ActivityPage>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const sourceId = source?.id;
  const sourceType = source?.type;
  const requestKey = useMemo(
    () => ({
      refreshKey,
      reload,
      source:
        sourceId && sourceType ? { id: sourceId, type: sourceType } : undefined,
    }),
    [sourceId, sourceType, refreshKey, reload],
  );
  useEffect(() => {
    const current = ++generation.current;
    setPage(undefined);
    setError(undefined);
    setBusy(false);
    void listActivity(requestKey.source)
      .then((next) => {
        if (generation.current === current) setPage(next);
      })
      .catch((cause: unknown) => {
        if (generation.current === current) setError(messageFrom(cause));
      });
    return () => {
      generation.current += 1;
    };
  }, [requestKey]);

  async function loadMore() {
    if (!page?.nextCursor || busy) return;
    const current = generation.current;
    setBusy(true);
    setError(undefined);
    try {
      const next = await listActivity(source, page.nextCursor);
      if (generation.current === current) {
        setPage((previous) => ({
          events: [...(previous?.events ?? []), ...next.events],
          nextCursor: next.nextCursor,
        }));
      }
    } catch (cause) {
      if (generation.current === current) setError(messageFrom(cause));
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }

  return {
    busy,
    error,
    loadMore,
    page,
    refresh: () => setReload((value) => value + 1),
  };
}

function ActivityList({
  compact,
  events,
  onNavigate,
}: {
  compact: boolean;
  events: ActivityEvent[];
  onNavigate?: ((pathname: string) => void) | undefined;
}) {
  if (!events.length)
    return (
      <EmptyState compact icon="layers" title="No activity yet">
        Saved changes will appear here.
      </EmptyState>
    );
  return (
    <Card flush>
      <ol aria-label="Activity history" className="rowList activityList">
        {events.map((event) =>
          compact ? (
            <CompactActivityRow
              event={event}
              key={event.id}
              onNavigate={onNavigate}
            />
          ) : (
            <ActivityRow event={event} key={event.id} onNavigate={onNavigate} />
          ),
        )}
      </ol>
    </Card>
  );
}

function CompactActivityRow({
  event,
  onNavigate,
}: {
  event: ActivityEvent;
  onNavigate: ((pathname: string) => void) | undefined;
}) {
  const href = activityPath(event);
  return (
    <li className="row activityRow activityRowCompact">
      <div className="activityCompactHeading">
        <p className="activityHeading">
          <strong title={event.actor.email}>
            {event.actor.name || event.actor.email}
          </strong>{" "}
          {actionLabels[event.action] ?? event.action}
          {onNavigate && (
            <>
              {" · "}
              {href ? (
                <Button
                  aria-label={`Open ${event.root.type === "audit_run" ? "audit" : "form"}: ${event.root.label}`}
                  className="activityResource"
                  onClick={() => onNavigate(href)}
                  size="sm"
                  variant="link"
                >
                  {event.root.label}
                </Button>
              ) : (
                event.root.label
              )}
            </>
          )}
          {event.historical && (
            <span className="activityHistorical">
              <Badge>From existing records</Badge>
            </span>
          )}
        </p>
        <time className="activityTime" dateTime={event.occurredAt}>
          {formatActivityTime(event.occurredAt)}
        </time>
      </div>
      <details className="activityDisclosure">
        <summary>
          <span className="activitySummary">{activitySummary(event)}</span>
        </summary>
        <div className="activityExpanded">
          <p className="activityMeta">{event.actor.email}</p>
          <ActivityDetails event={event} />
        </div>
      </details>
    </li>
  );
}

function activitySummary(event: ActivityEvent) {
  const { details } = event;
  if (event.action === "audit.answer_changed") {
    return `${textValue(details.prompt)} · ${answerLabel(details.before, details.responseType)} → ${answerLabel(details.after, details.responseType)}`;
  }
  if (event.action.startsWith("audit.template_")) {
    return `Version ${textValue(details.version)}`;
  }
  return textValue(details.title) || textValue(details.filename) || "Details";
}

function ActivityRow({
  event,
  onNavigate,
}: {
  event: ActivityEvent;
  onNavigate: ((pathname: string) => void) | undefined;
}) {
  const href = activityPath(event);
  return (
    <li className="row activityRow">
      <div className="rowMain activityMain">
        <p className="activityHeading">
          <strong title={event.actor.email}>
            {event.actor.name || event.actor.email}
          </strong>{" "}
          {actionLabels[event.action] ?? event.action}
        </p>
        <p className="activityMeta">
          {event.actor.email} ·{" "}
          <time dateTime={event.occurredAt}>
            {formatActivityTime(event.occurredAt)}
          </time>
        </p>
        {onNavigate && <p className="activityRoot">{event.root.label}</p>}
        <ActivityDetails event={event} />
        {event.historical && (
          <span>
            <Badge>From existing records</Badge>
          </span>
        )}
      </div>
      {onNavigate && href && (
        <Button onClick={() => onNavigate(href)} size="sm">
          {event.root.type === "audit_run" ? "Open audit" : "Open form"}
        </Button>
      )}
    </li>
  );
}

function ActivityDetails({ event }: { event: ActivityEvent }) {
  const details = event.details;
  switch (event.action) {
    case "audit.answer_changed":
      return (
        <div className="activityDetails">
          <p>{textValue(details.prompt)}</p>
          <p className="activityChange">
            <span>{answerLabel(details.before, details.responseType)}</span>
            <span aria-hidden="true">→</span>
            <span className="srOnly">changed to</span>
            <span>{answerLabel(details.after, details.responseType)}</span>
          </p>
        </div>
      );
    case "audit.issue_assigned":
      return (
        <div className="activityDetails">
          <p>{textValue(details.title)}</p>
          <p>
            {assigneeLabel(
              details.before,
              details.beforeName,
              details.beforeEmail,
            )}{" "}
            →{" "}
            {assigneeLabel(
              details.after,
              details.afterName,
              details.afterEmail,
            )}
          </p>
        </div>
      );
    case "audit.issue_created":
      return (
        <div className="activityDetails">
          <p>{textValue(details.title)}</p>
          {details.description ? <p>{textValue(details.description)}</p> : null}
          <p>
            Priority: {textValue(details.priority)}
            {!event.historical && (
              <>
                {" "}
                · Assigned to:{" "}
                {assigneeLabel(
                  details.assignedTo,
                  details.assigneeName,
                  details.assigneeEmail,
                )}
              </>
            )}
          </p>
        </div>
      );
    case "audit.image_uploaded":
    case "audit.image_removed":
      return (
        <p className="activityDetails">
          {textValue(details.filename)} · {textValue(details.title)}
        </p>
      );
    case "audit.template_created":
    case "audit.template_version_saved":
      return (
        <p className="activityDetails">Version {textValue(details.version)}</p>
      );
    default:
      return details.title ? (
        <p className="activityDetails">{textValue(details.title)}</p>
      ) : null;
  }
}

function assigneeLabel(id: unknown, name: unknown, email: unknown) {
  return id == null
    ? "Unassigned"
    : textValue(name) || textValue(email) || textValue(id);
}

function answerLabel(value: unknown, responseType: unknown) {
  if (value == null || value === "") return "Unanswered";
  if (responseType === "check") {
    if (value === "na") return "N/A";
    if (value === "pass") return "Pass";
    if (value === "fail") return "Fail";
  }
  return textValue(value);
}

function textValue(value: unknown) {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function activityPath(event: ActivityEvent) {
  if (event.root.type === "audit_run")
    return `/audits/runs/${encodeURIComponent(event.root.id)}`;
  if (event.root.type === "audit_template")
    return `/audits/templates/${encodeURIComponent(event.root.id)}`;
  return undefined;
}

export function formatActivityTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not load activity.";
}
