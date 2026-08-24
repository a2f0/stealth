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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const [nextTemplates, nextRuns] = await Promise.all([
        listAuditTemplates(),
        listAuditRuns(),
      ]);
      setTemplates(nextTemplates);
      setRuns(nextRuns);
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

  return (
    <>
      <header className="topbar">
        <div>
          <p className="eyebrow">Inspections &amp; compliance</p>
          <h1>Audits</h1>
        </div>
        <div className="auditHeaderActions">
          {canManageGlobal && (
            <button
              disabled={busy}
              onClick={() => void createTemplate("global")}
              type="button"
            >
              New global checklist
            </button>
          )}
          <button
            className="primaryButton"
            disabled={busy}
            onClick={() => void createTemplate("organization")}
            type="button"
          >
            New organization checklist
          </button>
        </div>
      </header>
      <section className="content auditHome">
        {error && <div className="errorBanner">{error}</div>}
        <TemplateGrid
          busy={busy}
          canManageGlobal={canManageGlobal}
          onBegin={beginAudit}
          onEdit={(id) => onNavigate(`/audits/templates/${id}`)}
          onManage={(id) => onNavigate(`/audits/global-templates/${id}`)}
          templates={templates}
        />
        <AuditHistory
          onOpen={(id) => onNavigate(`/audits/runs/${id}`)}
          runs={runs}
        />
      </section>
    </>
  );
}

function TemplateGrid({
  busy,
  canManageGlobal,
  onBegin,
  onEdit,
  onManage,
  templates,
}: {
  busy: boolean;
  canManageGlobal: boolean;
  onBegin: (id: string) => Promise<void>;
  onEdit: (id: string) => void;
  onManage: (id: string) => void;
  templates: AuditTemplate[] | undefined;
}) {
  return (
    <section>
      <div className="sectionHeading">
        <h2>Checklist templates</h2>
        <span>{templates?.length ?? 0} templates</span>
      </div>
      {templates && (
        <div className="auditTemplateCollections">
          <TemplateCollection
            busy={busy}
            canManageGlobal={canManageGlobal}
            emptyMessage="No global checklists are available yet."
            onBegin={onBegin}
            onEdit={onEdit}
            onManage={onManage}
            scope="global"
            templates={templates.filter(({ scope }) => scope === "global")}
            title="Global forms"
          />
          <TemplateCollection
            busy={busy}
            canManageGlobal={false}
            emptyMessage="No forms have been created for this organization yet."
            onBegin={onBegin}
            onEdit={onEdit}
            onManage={onManage}
            scope="organization"
            templates={templates.filter(
              ({ scope }) => scope === "organization",
            )}
            title="Organization forms"
          />
        </div>
      )}
      {!templates && <p className="auditLoading">Loading checklists…</p>}
    </section>
  );
}

function TemplateCollection({
  busy,
  canManageGlobal,
  emptyMessage,
  onBegin,
  onEdit,
  onManage,
  scope,
  templates,
  title,
}: {
  busy: boolean;
  canManageGlobal: boolean;
  emptyMessage: string;
  onBegin: (id: string) => Promise<void>;
  onEdit: (id: string) => void;
  onManage: (id: string) => void;
  scope: AuditTemplateScope;
  templates: AuditTemplate[];
  title: string;
}) {
  return (
    <section className="auditTemplateCollection">
      <div className="auditCollectionHeading">
        <div>
          <h3>{title}</h3>
          <p>
            {scope === "global"
              ? "Available in every organization."
              : "Private to the active organization."}
          </p>
        </div>
        <span>{templates.length}</span>
      </div>
      {templates.length > 0 ? (
        <div className="auditTemplateGrid">
          {templates.map((template) => (
            <article className="auditTemplateCard" key={template.id}>
              <div>
                <div className="auditTemplateBadges">
                  <span className="auditStatus">{template.status}</span>
                  <span className="auditScope">
                    {scopeLabel(template.scope)}
                  </span>
                </div>
                <h3>{template.name}</h3>
                <p>{template.description || "A custom checklist."}</p>
              </div>
              <span className="auditCardMeta">
                v{template.version} · {itemCount(template)} items ·{" "}
                {template.definition.sections.length} sections
              </span>
              <div className="auditCardActions">
                <button onClick={() => onEdit(template.id)} type="button">
                  {scope === "global" ? "Customize" : "Edit"}
                </button>
                {scope === "global" && canManageGlobal && (
                  <button onClick={() => onManage(template.id)} type="button">
                    Manage global
                  </button>
                )}
                <button
                  className="primaryButton"
                  disabled={busy}
                  onClick={() => void onBegin(template.id)}
                  type="button"
                >
                  Start audit
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="auditCollectionEmpty">{emptyMessage}</p>
      )}
    </section>
  );
}

function AuditHistory({
  onOpen,
  runs,
}: {
  onOpen: (id: string) => void;
  runs: AuditSummary[] | undefined;
}) {
  return (
    <section className="auditHistory">
      <div className="sectionHeading">
        <h2>Recent audits</h2>
        <span>{runs?.length ?? 0} audits</span>
      </div>
      {runs?.length ? (
        <div className="auditRunList">
          {runs.map((run) => (
            <button key={run.id} onClick={() => onOpen(run.id)} type="button">
              <span>
                <strong>{run.templateName}</strong>
                <small>
                  {run.templateVersion ? `v${run.templateVersion} · ` : ""}
                  {formatDate(run.updatedAt)}
                </small>
              </span>
              <span className={`auditStatus ${run.status}`}>{status(run)}</span>
              <span>{run.responseCount} answered</span>
              <span>{run.issueCount} issues</span>
              <b>→</b>
            </button>
          ))}
        </div>
      ) : runs ? (
        <div className="emptyState compactEmptyState">
          <div className="emptyGlyph">✓</div>
          <h3>No audits yet.</h3>
          <p>Start one from a checklist above.</p>
        </div>
      ) : (
        <p className="auditLoading">Loading audits…</p>
      )}
    </section>
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
