import { useEffect, useState } from "react";
import {
  type AuditTemplate,
  type AuditTemplateItem,
  type AuditTemplateSection,
  type AuditTemplateVersion,
  getAuditTemplate,
  getAuditTemplateVersion,
  listAuditTemplateVersions,
  updateAuditTemplate,
} from "./auditApi";

interface BuilderProps {
  id: string;
  isPlatformAdmin: boolean;
  onNavigate: (pathname: string) => void;
}

export function AuditTemplateBuilder({
  id,
  isPlatformAdmin,
  onNavigate,
}: BuilderProps) {
  const [template, setTemplate] = useState<AuditTemplate>();
  const [versions, setVersions] = useState<AuditTemplateVersion[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    Promise.all([getAuditTemplate(id), listAuditTemplateVersions(id)])
      .then(([nextTemplate, nextVersions]) => {
        setTemplate(nextTemplate);
        setVersions(nextVersions);
      })
      .catch((cause: unknown) => setError(messageFrom(cause)));
  }, [id]);

  async function selectVersion(version: number) {
    if (!template || version === template.version) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const selected =
        version === template.currentVersion
          ? await getAuditTemplate(id)
          : await getAuditTemplateVersion(id, version);
      setTemplate(selected);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!template) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const saved = await updateAuditTemplate(template);
      setTemplate(saved);
      setVersions(await listAuditTemplateVersions(id));
      setNotice(`Version ${saved.version} saved.`);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!template) {
    return (
      <BuilderLoading error={error} onBack={() => onNavigate("/audits")} />
    );
  }

  const canEdit = template.scope === "organization" || isPlatformAdmin;

  return (
    <>
      <BuilderHeader
        busy={busy}
        canEdit={canEdit}
        onBack={() => onNavigate("/audits")}
        onSave={save}
        onVersionChange={selectVersion}
        template={template}
        versions={versions ?? []}
      />
      <BuilderBody
        canEdit={canEdit}
        error={error}
        notice={notice}
        onChange={(nextTemplate) => {
          setTemplate(nextTemplate);
          setNotice(undefined);
        }}
        template={template}
      />
    </>
  );
}

function BuilderBody({
  canEdit,
  error,
  notice,
  onChange,
  template,
}: {
  canEdit: boolean;
  error: string | undefined;
  notice: string | undefined;
  onChange: (template: AuditTemplate) => void;
  template: AuditTemplate;
}) {
  const updateSections = (sections: AuditTemplateSection[]) =>
    onChange({
      ...template,
      definition: { ...template.definition, sections },
    });
  return (
    <section className="content auditBuilder">
      {error && <div className="errorBanner">{error}</div>}
      {notice && <div className="successBanner pageBanner">{notice}</div>}
      {!canEdit && (
        <div className="auditVersionNotice">
          Global forms are available to every organization and can only be
          revised by a Tearleads platform administrator.
        </div>
      )}
      {template.version < template.currentVersion && (
        <div className="auditVersionNotice">
          {canEdit ? (
            <>
              You are viewing version {template.version}. Saving changes will
              create version {template.currentVersion + 1}; this version will
              stay unchanged.
            </>
          ) : (
            <>
              You are viewing version {template.version}. The latest version is{" "}
              {template.currentVersion}.
            </>
          )}
        </div>
      )}
      <fieldset className="auditBuilderFields" disabled={!canEdit}>
        <TemplateDetails template={template} update={onChange} />
        <div className="auditBuilderSections">
          {template.definition.sections.map((section, index) => (
            <SectionEditor
              canRemove={template.definition.sections.length > 1}
              index={index}
              key={section.id}
              onChange={(nextSection) =>
                updateSections(
                  replaceById(template.definition.sections, nextSection),
                )
              }
              onRemove={() =>
                updateSections(
                  template.definition.sections.filter(
                    (candidate) => candidate.id !== section.id,
                  ),
                )
              }
              section={section}
            />
          ))}
        </div>
        <button
          className="auditAddButton"
          onClick={() =>
            updateSections([...template.definition.sections, newSection()])
          }
          type="button"
        >
          + Add section
        </button>
      </fieldset>
    </section>
  );
}

function BuilderHeader({
  busy,
  canEdit,
  onBack,
  onSave,
  onVersionChange,
  template,
  versions,
}: {
  busy: boolean;
  canEdit: boolean;
  onBack: () => void;
  onSave: () => Promise<void>;
  onVersionChange: (version: number) => Promise<void>;
  template: AuditTemplate;
  versions: AuditTemplateVersion[];
}) {
  return (
    <header className="topbar auditEditorTopbar">
      <div>
        <button className="auditBack" onClick={onBack} type="button">
          ← Audits
        </button>
        <p className="eyebrow">
          {template.scope === "global" ? "Global form" : "Organization form"}
          {" · "}Version {template.version} of {template.currentVersion}
        </p>
        <h1>{canEdit ? "Edit template" : "View template"}</h1>
      </div>
      <div className="auditVersionControls">
        <label>
          <span>Version</span>
          <select
            disabled={busy || versions.length === 0}
            onChange={(event) =>
              void onVersionChange(Number(event.target.value))
            }
            value={template.version}
          >
            {versions.map((version) => (
              <option key={version.version} value={version.version}>
                v{version.version} · {formatVersionDate(version.createdAt)} ·{" "}
                {version.createdBy.name}
              </option>
            ))}
          </select>
        </label>
        {canEdit && (
          <button
            className="primaryButton"
            disabled={busy}
            onClick={() => void onSave()}
            type="button"
          >
            {busy
              ? "Saving…"
              : `Save as version ${template.currentVersion + 1}`}
          </button>
        )}
      </div>
    </header>
  );
}

function TemplateDetails({
  template,
  update,
}: {
  template: AuditTemplate;
  update: (template: AuditTemplate) => void;
}) {
  return (
    <div className="auditDetailsCard">
      <label className="field">
        <span>Checklist name</span>
        <input
          maxLength={200}
          onChange={(event) =>
            update({ ...template, name: event.target.value })
          }
          required
          value={template.name}
        />
      </label>
      <label className="field">
        <span>Description</span>
        <textarea
          maxLength={2000}
          onChange={(event) =>
            update({ ...template, description: event.target.value })
          }
          placeholder="What should an auditor know before starting?"
          rows={3}
          value={template.description}
        />
      </label>
    </div>
  );
}

function SectionEditor({
  canRemove,
  index,
  onChange,
  onRemove,
  section,
}: {
  canRemove: boolean;
  index: number;
  onChange: (section: AuditTemplateSection) => void;
  onRemove: () => void;
  section: AuditTemplateSection;
}) {
  const updateItem = (item: AuditTemplateItem) =>
    onChange({ ...section, items: replaceById(section.items, item) });
  return (
    <article className="auditSectionEditor">
      <div className="auditSectionHeader">
        <span>{String(index + 1).padStart(2, "0")}</span>
        <input
          aria-label={`Section ${index + 1} title`}
          maxLength={200}
          onChange={(event) =>
            onChange({ ...section, title: event.target.value })
          }
          value={section.title}
        />
        <button disabled={!canRemove} onClick={onRemove} type="button">
          Remove
        </button>
      </div>
      <div className="auditQuestionList">
        {section.items.map((item, itemIndex) => (
          <QuestionEditor
            canRemove={section.items.length > 1}
            index={itemIndex}
            item={item}
            key={item.id}
            onChange={updateItem}
            onRemove={() =>
              onChange({
                ...section,
                items: section.items.filter(
                  (candidate) => candidate.id !== item.id,
                ),
              })
            }
          />
        ))}
      </div>
      <button
        className="auditAddQuestion"
        onClick={() =>
          onChange({ ...section, items: [...section.items, newItem()] })
        }
        type="button"
      >
        + Add question
      </button>
    </article>
  );
}

function QuestionEditor({
  canRemove,
  index,
  item,
  onChange,
  onRemove,
}: {
  canRemove: boolean;
  index: number;
  item: AuditTemplateItem;
  onChange: (item: AuditTemplateItem) => void;
  onRemove: () => void;
}) {
  return (
    <div className="auditQuestionEditor">
      <span>{index + 1}</span>
      <textarea
        aria-label={`Question ${index + 1}`}
        maxLength={500}
        onChange={(event) => onChange({ ...item, prompt: event.target.value })}
        rows={2}
        value={item.prompt}
      />
      <select
        aria-label="Response type"
        onChange={(event) =>
          onChange({
            ...item,
            responseType: event.target.value === "text" ? "text" : "check",
          })
        }
        value={item.responseType}
      >
        <option value="check">Pass / fail / N/A</option>
        <option value="text">Text answer</option>
      </select>
      <label className="auditRequired">
        <input
          checked={item.required}
          onChange={(event) =>
            onChange({ ...item, required: event.target.checked })
          }
          type="checkbox"
        />
        Required
      </label>
      <button disabled={!canRemove} onClick={onRemove} type="button">
        ×
      </button>
    </div>
  );
}

function BuilderLoading({
  error,
  onBack,
}: {
  error: string | undefined;
  onBack: () => void;
}) {
  return (
    <section className="content auditStandaloneState">
      {error ? <div className="errorBanner">{error}</div> : <p>Loading…</p>}
      <button className="textButton" onClick={onBack} type="button">
        Return to audits
      </button>
    </section>
  );
}

function newItem(): AuditTemplateItem {
  return {
    id: crypto.randomUUID(),
    prompt: "Untitled question",
    required: true,
    responseType: "check",
  };
}

function newSection(): AuditTemplateSection {
  return { id: crypto.randomUUID(), items: [newItem()], title: "New section" };
}

function replaceById<T extends { id: string }>(items: T[], replacement: T) {
  return items.map((item) => (item.id === replacement.id ? replacement : item));
}

function formatVersionDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(value),
  );
}

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not save checklist.";
}
