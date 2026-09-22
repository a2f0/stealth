import {
  Badge,
  type BadgeTone,
  Banner,
  Button,
  Card,
  EmptyState,
  Icon,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
} from "@tearleads/ui/react";
import { useCallback, useEffect, useState } from "react";
import {
  type AuditSummary,
  type AuditTemplate,
  type AuditTemplateScope,
  createAuditTemplate,
  listAuditRuns,
  listAuditTemplates,
  startAudit,
} from "./auditApi";

export function AuditHome({
  canManageGlobal,
  onNavigate,
}: {
  canManageGlobal: boolean;
  onNavigate: (pathname: string) => void;
}) {
  const [templates, setTemplates] = useState<AuditTemplate[]>();
  const [runs, setRuns] = useState<AuditSummary[]>();
  const [nextRunCursor, setNextRunCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingMoreRuns, setLoadingMoreRuns] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const [nextTemplates, nextRuns] = await Promise.all([
        listAuditTemplates(),
        listAuditRuns(),
      ]);
      setTemplates(nextTemplates);
      setRuns(nextRuns.audits);
      setNextRunCursor(nextRuns.nextCursor);
    } catch (cause) {
      setError(messageFrom(cause));
    }
  }, []);

  useEffect(() => void load(), [load]);

  async function createTemplate(scope: AuditTemplateScope) {
    setBusy(true);
    setError(undefined);
    try {
      const template = await createAuditTemplate("Untitled checklist", scope);
      const collection = scope === "global" ? "global-templates" : "templates";
      onNavigate(`/audits/${collection}/${template.id}`);
    } catch (cause) {
      setError(messageFrom(cause));
      setBusy(false);
    }
  }

  async function beginAudit(templateId: string) {
    setBusy(true);
    setError(undefined);
    try {
      const auditId = await startAudit(templateId);
      onNavigate(`/audits/runs/${auditId}`);
    } catch (cause) {
      setError(messageFrom(cause));
      setBusy(false);
    }
  }

  async function loadMoreRuns() {
    if (!nextRunCursor) return;
    setLoadingMoreRuns(true);
    setError(undefined);
    try {
      const page = await listAuditRuns(nextRunCursor);
      setRuns((current) => [...(current ?? []), ...page.audits]);
      setNextRunCursor(page.nextCursor);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setLoadingMoreRuns(false);
    }
  }

  return (
    <Page>
      <AuditHomeHeader
        busy={busy}
        canManageGlobal={canManageGlobal}
        onCreate={createTemplate}
      />
      <PageBody>
        {error && <Banner tone="danger">{error}</Banner>}
        <TemplateGrid
          busy={busy}
          canManageGlobal={canManageGlobal}
          onBegin={beginAudit}
          onEdit={(id) => onNavigate(`/audits/templates/${id}`)}
          onManage={(id) => onNavigate(`/audits/global-templates/${id}`)}
          templates={templates}
        />
        <AuditHistory
          hasMore={Boolean(nextRunCursor)}
          loadingMore={loadingMoreRuns}
          onLoadMore={loadMoreRuns}
          onOpen={(id) => onNavigate(`/audits/runs/${id}`)}
          runs={runs}
        />
      </PageBody>
    </Page>
  );
}

function AuditHomeHeader({
  busy,
  canManageGlobal,
  onCreate,
}: {
  busy: boolean;
  canManageGlobal: boolean;
  onCreate: (scope: AuditTemplateScope) => Promise<void>;
}) {
  return (
    <PageHeader
      actions={
        <>
          {canManageGlobal && (
            <Button
              disabled={busy}
              icon="add"
              onClick={() => void onCreate("global")}
            >
              New global checklist
            </Button>
          )}
          <Button
            disabled={busy}
            icon="add"
            onClick={() => void onCreate("organization")}
            variant="primary"
          >
            New organization checklist
          </Button>
        </>
      }
      description="Run inspections from shared or organization checklists and keep every finding in one place."
      eyebrow="Inspections & compliance"
      title="Audits"
    />
  );
}

interface TemplateActions {
  busy: boolean;
  onBegin: (id: string) => Promise<void>;
  onEdit: (id: string) => void;
  onManage: (id: string) => void;
}

function TemplateGrid({
  canManageGlobal,
  templates,
  ...actions
}: TemplateActions & {
  canManageGlobal: boolean;
  templates: AuditTemplate[] | undefined;
}) {
  return (
    <PageSection
      actions={
        templates && (
          <span className="sectionCount">
            {countLabel(templates.length, "template")}
          </span>
        )
      }
      title="Checklist templates"
    >
      {templates ? (
        <div className="auditCollections">
          <TemplateCollection
            {...actions}
            canManageGlobal={canManageGlobal}
            description="Available in every organization."
            emptyMessage="No global checklists are available yet."
            emptyTitle="No global forms"
            templates={templates.filter(({ scope }) => scope === "global")}
            title="Global forms"
          />
          <TemplateCollection
            {...actions}
            canManageGlobal={false}
            description="Private to the active organization."
            emptyMessage="No forms have been created for this organization yet. Customize a global form or start a new checklist."
            emptyTitle="No organization forms yet"
            templates={templates.filter(
              ({ scope }) => scope === "organization",
            )}
            title="Organization forms"
          />
        </div>
      ) : (
        <LoadingState label="Loading checklists…" />
      )}
    </PageSection>
  );
}

function TemplateCollection({
  canManageGlobal,
  description,
  emptyMessage,
  emptyTitle,
  templates,
  title,
  ...actions
}: TemplateActions & {
  canManageGlobal: boolean;
  description: string;
  emptyMessage: string;
  emptyTitle: string;
  templates: AuditTemplate[];
  title: string;
}) {
  return (
    <section className="auditCollection">
      <div className="auditCollectionHeading">
        <h3 className="auditCollectionTitle">
          {title}
          <Badge>{templates.length}</Badge>
        </h3>
        <p className="textSm textMuted">{description}</p>
      </div>
      {templates.length > 0 ? (
        <div className="gridAuto auditTemplateGrid">
          {templates.map((template) => (
            <TemplateCard
              {...actions}
              canManageGlobal={canManageGlobal}
              key={template.id}
              template={template}
            />
          ))}
        </div>
      ) : (
        <EmptyState compact icon="checklist" title={emptyTitle}>
          {emptyMessage}
        </EmptyState>
      )}
    </section>
  );
}

function TemplateCard({
  busy,
  canManageGlobal,
  onBegin,
  onEdit,
  onManage,
  template,
}: TemplateActions & { canManageGlobal: boolean; template: AuditTemplate }) {
  const isGlobal = template.scope === "global";
  const sectionCount = template.definition.sections.length;
  return (
    <article className="card auditTemplateCard">
      <div className="auditTemplateBody">
        <div className="cluster">
          <Badge dot tone={templateStatusTone(template.status)}>
            {formatLabel(template.status)}
          </Badge>
          <Badge tone="info">{scopeLabel(template.scope)}</Badge>
        </div>
        <h4 className="auditTemplateName">{template.name}</h4>
        <p className="auditTemplateDescription">
          {template.description || "A custom checklist."}
        </p>
        <p className="auditTemplateMeta">
          <span className="cluster auditTemplateStat">
            <Icon name="checklist" size={16} />
            {countLabel(itemCount(template), "item")}
          </span>
          <span className="cluster auditTemplateStat">
            <Icon name="layers" size={16} />
            {countLabel(sectionCount, "section")}
          </span>
          <span className="auditTemplateStat mono">v{template.version}</span>
        </p>
      </div>
      <div className="cardFooter auditTemplateFooter">
        <div className="cluster auditTemplateActions">
          <Button icon="edit" onClick={() => onEdit(template.id)} size="sm">
            {isGlobal ? "Customize" : "Edit"}
          </Button>
          {isGlobal && canManageGlobal && (
            <Button onClick={() => onManage(template.id)} size="sm">
              Manage global
            </Button>
          )}
        </div>
        <Button
          className="auditTemplateStart"
          disabled={busy}
          iconEnd="arrowRight"
          onClick={() => void onBegin(template.id)}
          size="sm"
          variant="primary"
        >
          Start audit
        </Button>
      </div>
    </article>
  );
}

function AuditHistory({
  hasMore,
  loadingMore,
  onLoadMore,
  onOpen,
  runs,
}: {
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => Promise<void>;
  onOpen: (id: string) => void;
  runs: AuditSummary[] | undefined;
}) {
  return (
    <PageSection
      actions={
        runs && (
          <span className="sectionCount">
            {runs.length}
            {hasMore ? "+" : ""}{" "}
            {runs.length === 1 && !hasMore ? "audit" : "audits"}
          </span>
        )
      }
      title="Recent audits"
    >
      {runs?.length ? (
        <Card
          className="auditRunCard"
          flush
          footer={
            hasMore && (
              <Button
                busy={loadingMore}
                onClick={() => void onLoadMore()}
                size="sm"
              >
                {loadingMore ? "Loading…" : "Load more audits"}
              </Button>
            )
          }
        >
          <div className="rowList">
            {runs.map((run) => (
              <AuditRunRow key={run.id} onOpen={onOpen} run={run} />
            ))}
          </div>
        </Card>
      ) : runs ? (
        <EmptyState compact icon="audits" title="No audits yet">
          Start one from a checklist above.
        </EmptyState>
      ) : (
        <LoadingState label="Loading audits…" />
      )}
    </PageSection>
  );
}

function AuditRunRow({
  onOpen,
  run,
}: {
  onOpen: (id: string) => void;
  run: AuditSummary;
}) {
  return (
    <button
      className="row auditRunRow"
      onClick={() => onOpen(run.id)}
      type="button"
    >
      <span className="rowMain">
        <span className="rowTitle">{run.templateName}</span>
        <span className="rowMeta">
          {run.templateVersion ? `v${run.templateVersion} · ` : ""}
          {formatDate(run.updatedAt)}
        </span>
      </span>
      <span className="auditRunStats">
        <Badge dot tone={run.status === "completed" ? "success" : "warning"}>
          {status(run)}
        </Badge>
        <span className="auditRunStat">
          <Icon name="check" size={16} />
          {run.responseCount} answered
        </span>
        <span className="auditRunStat">
          <Icon name="issues" size={16} />
          {countLabel(run.issueCount, "issue")}
        </span>
      </span>
      <Icon className="auditRunArrow" name="arrowRight" />
    </button>
  );
}

function itemCount(template: AuditTemplate) {
  return template.definition.sections.reduce(
    (count, section) => count + section.items.length,
    0,
  );
}

function status(run: AuditSummary) {
  return run.status === "completed" ? "Completed" : "In progress";
}

function templateStatusTone(value: string): BadgeTone {
  if (value === "published") return "success";
  return "neutral";
}

function formatLabel(value: string) {
  const text = value.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function countLabel(count: number, noun: string) {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

function scopeLabel(scope: AuditTemplateScope) {
  return scope === "global" ? "Global" : "Organization";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(value),
  );
}

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not load audits.";
}
