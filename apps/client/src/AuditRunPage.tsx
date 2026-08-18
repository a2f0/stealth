import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type AuditDefinition,
  type AuditDetail,
  type AuditIssue,
  type AuditTemplateItem,
  createAuditIssue,
  getAuditRun,
  type OrganizationMember,
  saveAuditRun,
  updateAuditIssue,
} from "./auditApi";

interface AuditRunPageProps {
  id: string;
  onNavigate: (pathname: string) => void;
}

export function AuditRunPage({ id, onNavigate }: AuditRunPageProps) {
  const [detail, setDetail] = useState<AuditDetail>();
  const [responses, setResponses] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const load = useCallback(async () => {
    try {
      const nextDetail = await getAuditRun(id);
      setDetail(nextDetail);
      setResponses(nextDetail.audit.responses);
    } catch (cause) {
      setError(messageFrom(cause));
    }
  }, [id]);

  useEffect(() => void load(), [load]);

  async function save(status: "completed" | "in_progress") {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await saveAuditRun(id, responses, status);
      await load();
      setNotice(status === "completed" ? "Audit completed." : "Draft saved.");
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!detail) {
    return <RunLoading error={error} onBack={() => onNavigate("/audits")} />;
  }

  return (
    <>
      <RunHeader
        busy={busy}
        name={detail.audit.templateName}
        onBack={() => onNavigate("/audits")}
        onSave={save}
        status={detail.audit.status}
      />
      <section className="content auditRunContent">
        {error && <div className="errorBanner">{error}</div>}
        {notice && <div className="successBanner pageBanner">{notice}</div>}
        <AuditQuestions
          definition={detail.audit.definition}
          onChange={(itemId, response) =>
            setResponses((current) => ({ ...current, [itemId]: response }))
          }
          responses={responses}
        />
        <IssuePanel
          auditId={id}
          definition={detail.audit.definition}
          issues={detail.issues}
          members={detail.members}
          onChange={load}
          responses={responses}
        />
      </section>
    </>
  );
}

function RunHeader({
  busy,
  name,
  onBack,
  onSave,
  status,
}: {
  busy: boolean;
  name: string;
  onBack: () => void;
  onSave: (status: "completed" | "in_progress") => Promise<void>;
  status: string;
}) {
  return (
    <header className="topbar auditEditorTopbar">
      <div>
        <button className="auditBack" onClick={onBack} type="button">
          ← Audits
        </button>
        <p className="eyebrow">Audit · {status.replace("_", " ")}</p>
        <h1>{name}</h1>
      </div>
      <div className="auditHeaderActions">
        <button
          disabled={busy}
          onClick={() => void onSave("in_progress")}
          type="button"
        >
          Save draft
        </button>
        <button
          className="primaryButton"
          disabled={busy}
          onClick={() => void onSave("completed")}
          type="button"
        >
          Complete audit
        </button>
      </div>
    </header>
  );
}

function AuditQuestions({
  definition,
  onChange,
  responses,
}: {
  definition: AuditDefinition;
  onChange: (itemId: string, response: string) => void;
  responses: Record<string, string>;
}) {
  return (
    <div className="auditRunSections">
      {definition.sections.map((section, sectionIndex) => (
        <section className="auditRunSection" key={section.id}>
          <header>
            <span>{String(sectionIndex + 1).padStart(2, "0")}</span>
            <h2>{section.title}</h2>
          </header>
          {section.items.map((item, index) => (
            <AuditQuestion
              index={index}
              item={item}
              key={item.id}
              onChange={(response) => onChange(item.id, response)}
              response={responses[item.id] ?? ""}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

function AuditQuestion({
  index,
  item,
  onChange,
  response,
}: {
  index: number;
  item: AuditTemplateItem;
  onChange: (response: string) => void;
  response: string;
}) {
  return (
    <div className={`auditRunQuestion ${response === "fail" ? "failed" : ""}`}>
      <div className="auditQuestionPrompt">
        <span>{index + 1}</span>
        <p>
          {item.prompt}
          {item.required && <small>Required</small>}
        </p>
      </div>
      {item.responseType === "check" ? (
        <div className="auditResponseButtons">
          {(["pass", "fail", "na"] as const).map((value) => (
            <button
              className={response === value ? `selected ${value}` : ""}
              key={value}
              onClick={() => onChange(value)}
              type="button"
            >
              {value === "na" ? "N/A" : titleCase(value)}
            </button>
          ))}
        </div>
      ) : (
        <textarea
          maxLength={2000}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Enter response"
          rows={3}
          value={response}
        />
      )}
    </div>
  );
}

function IssuePanel({
  auditId,
  definition,
  issues,
  members,
  onChange,
  responses,
}: {
  auditId: string;
  definition: AuditDefinition;
  issues: AuditIssue[];
  members: OrganizationMember[];
  onChange: () => Promise<void>;
  responses: Record<string, string>;
}) {
  const items = useMemo(() => allItems(definition), [definition]);
  const [showForm, setShowForm] = useState(false);
  return (
    <section className="auditIssues">
      <div className="sectionHeading">
        <div>
          <h2>Issues</h2>
          <p>Track follow-up work discovered during this audit.</p>
        </div>
        <button
          onClick={() => setShowForm((current) => !current)}
          type="button"
        >
          {showForm ? "Cancel" : "+ Raise issue"}
        </button>
      </div>
      {showForm && (
        <IssueForm
          auditId={auditId}
          items={items}
          members={members}
          onCreated={async () => {
            setShowForm(false);
            await onChange();
          }}
          responses={responses}
        />
      )}
      <IssueList issues={issues} onChange={onChange} />
    </section>
  );
}

function IssueForm({
  auditId,
  items,
  members,
  onCreated,
  responses,
}: {
  auditId: string;
  items: AuditTemplateItem[];
  members: OrganizationMember[];
  onCreated: () => Promise<void>;
  responses: Record<string, string>;
}) {
  const suggested =
    items.find((item) => responses[item.id] === "fail") ?? items[0];
  const [itemId, setItemId] = useState(suggested?.id ?? "");
  const [title, setTitle] = useState(suggested?.prompt ?? "");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("medium");
  const [assignedTo, setAssignedTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      await createAuditIssue(auditId, {
        assignedTo: assignedTo || null,
        description,
        itemId,
        priority,
        title,
      });
      await onCreated();
    } catch (cause) {
      setError(messageFrom(cause));
      setBusy(false);
    }
  }

  return (
    <div className="auditIssueForm">
      {error && <div className="errorBanner">{error}</div>}
      <label className="field">
        <span>Checklist item</span>
        <select
          onChange={(event) => {
            const nextId = event.target.value;
            setItemId(nextId);
            setTitle(items.find((item) => item.id === nextId)?.prompt ?? "");
          }}
          value={itemId}
        >
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {responses[item.id] === "fail" ? "Failed · " : ""}
              {item.prompt}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Issue title</span>
        <input
          maxLength={300}
          onChange={(event) => setTitle(event.target.value)}
          value={title}
        />
      </label>
      <label className="field auditIssueDescription">
        <span>Details</span>
        <textarea
          maxLength={2000}
          onChange={(event) => setDescription(event.target.value)}
          rows={3}
          value={description}
        />
      </label>
      <label className="field">
        <span>Priority</span>
        <select
          onChange={(event) => setPriority(event.target.value)}
          value={priority}
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="critical">Critical</option>
        </select>
      </label>
      <label className="field">
        <span>Assignee</span>
        <select
          onChange={(event) => setAssignedTo(event.target.value)}
          value={assignedTo}
        >
          <option value="">Unassigned</option>
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name} · {member.email}
            </option>
          ))}
        </select>
      </label>
      <button
        className="primaryButton"
        disabled={busy || !itemId || !title.trim()}
        onClick={() => void submit()}
        type="button"
      >
        {busy ? "Creating…" : "Create issue"}
      </button>
    </div>
  );
}

function IssueList({
  issues,
  onChange,
}: {
  issues: AuditIssue[];
  onChange: () => Promise<void>;
}) {
  if (!issues.length) return <p className="auditNoIssues">No issues raised.</p>;
  return (
    <div className="auditIssueList">
      {issues.map((issue) => (
        <article key={issue.id}>
          <span className={`auditPriority ${issue.priority}`}>
            {issue.priority}
          </span>
          <div>
            <h3>{issue.title}</h3>
            {issue.description && <p>{issue.description}</p>}
            <small>
              {issue.assigneeName
                ? `Assigned to ${issue.assigneeName}`
                : "Unassigned"}
            </small>
          </div>
          <button
            onClick={async () => {
              await updateAuditIssue(
                issue.id,
                issue.status === "open" ? "resolved" : "open",
              );
              await onChange();
            }}
            type="button"
          >
            {issue.status === "open" ? "Resolve" : "Reopen"}
          </button>
        </article>
      ))}
    </div>
  );
}

function RunLoading({
  error,
  onBack,
}: {
  error: string | undefined;
  onBack: () => void;
}) {
  return (
    <section className="content auditStandaloneState">
      {error ? (
        <div className="errorBanner">{error}</div>
      ) : (
        <p>Loading audit…</p>
      )}
      <button className="textButton" onClick={onBack} type="button">
        Return to audits
      </button>
    </section>
  );
}

function allItems(definition: AuditDefinition) {
  return definition.sections.flatMap((section) => section.items);
}

function titleCase(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not update audit.";
}
