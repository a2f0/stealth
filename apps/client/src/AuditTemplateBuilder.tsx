import { useEffect, useState } from "react";
import {
  type AuditTemplate,
  type AuditTemplateItem,
  type AuditTemplateSection,
  getAuditTemplate,
  updateAuditTemplate,
} from "./auditApi";

interface BuilderProps {
  id: string;
  onNavigate: (pathname: string) => void;
}

export function AuditTemplateBuilder({ id, onNavigate }: BuilderProps) {
  const [template, setTemplate] = useState<AuditTemplate>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    getAuditTemplate(id)
      .then(setTemplate)
      .catch((cause: unknown) => setError(messageFrom(cause)));
  }, [id]);

  async function save() {
    if (!template) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await updateAuditTemplate(template);
      setTemplate({ ...template, updatedAt: result.updatedAt });
      setNotice("Checklist saved.");
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

  const updateSections = (sections: AuditTemplateSection[]) => {
    setTemplate({
      ...template,
      definition: { ...template.definition, sections },
    });
    setNotice(undefined);
  };

  return (
    <>
      <BuilderHeader
        busy={busy}
        onBack={() => onNavigate("/audits")}
        onSave={save}
      />
      <section className="content auditBuilder">
        {error && <div className="errorBanner">{error}</div>}
        {notice && <div className="successBanner pageBanner">{notice}</div>}
        <TemplateDetails template={template} update={setTemplate} />
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
      </section>
    </>
  );
}

function BuilderHeader({
  busy,
  onBack,
  onSave,
}: {
  busy: boolean;
  onBack: () => void;
  onSave: () => Promise<void>;
}) {
  return (
    <header className="topbar auditEditorTopbar">
      <div>
        <button className="auditBack" onClick={onBack} type="button">
          ← Audits
        </button>
        <p className="eyebrow">Checklist builder</p>
        <h1>Edit template</h1>
      </div>
      <button
        className="primaryButton"
        disabled={busy}
        onClick={() => void onSave()}
        type="button"
      >
        {busy ? "Saving…" : "Save checklist"}
      </button>
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

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not save checklist.";
}
