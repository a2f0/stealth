import { useCallback, useEffect, useState } from "react";
import {
  type AuditSummary,
  type AuditTemplate,
  createAuditTemplate,
  listAuditRuns,
  listAuditTemplates,
  startAudit,
} from "./auditApi";

export function AuditHome({
  onNavigate,
}: {
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

  async function createTemplate() {
    setBusy(true);
    setError(undefined);
    try {
      const template = await createAuditTemplate("Untitled checklist");
      onNavigate(`/audits/templates/${template.id}`);
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
        <button
          className="primaryButton"
          disabled={busy}
          onClick={() => void createTemplate()}
          type="button"
        >
          New checklist
        </button>
      </header>
      <section className="content auditHome">
        {error && <div className="errorBanner">{error}</div>}
        <TemplateGrid
          busy={busy}
          onBegin={beginAudit}
          onEdit={(id) => onNavigate(`/audits/templates/${id}`)}
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
  onBegin,
  onEdit,
  templates,
}: {
  busy: boolean;
  onBegin: (id: string) => Promise<void>;
  onEdit: (id: string) => void;
  templates: AuditTemplate[] | undefined;
}) {
  return (
    <section>
      <div className="sectionHeading">
        <h2>Checklist templates</h2>
        <span>{templates?.length ?? 0} templates</span>
      </div>
      <div className="auditTemplateGrid">
        {templates?.map((template) => (
          <article className="auditTemplateCard" key={template.id}>
            <div>
              <span className="auditStatus">{template.status}</span>
              <h3>{template.name}</h3>
              <p>{template.description || "A custom checklist."}</p>
            </div>
            <span className="auditCardMeta">
              {itemCount(template)} items ·{" "}
              {template.definition.sections.length} sections
            </span>
            <div className="auditCardActions">
              <button onClick={() => onEdit(template.id)} type="button">
                Edit
              </button>
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
      {!templates && <p className="auditLoading">Loading checklists…</p>}
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
                <small>{formatDate(run.updatedAt)}</small>
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

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(value),
  );
}

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not load audits.";
}
