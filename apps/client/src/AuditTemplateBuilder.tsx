import {
  Banner,
  Button,
  Card,
  EmptyState,
  Field,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
} from "@tearleads/ui/react";
import { useEffect, useState } from "react";
import {
  type AuditTemplate,
  type AuditTemplateItem,
  type AuditTemplateSection,
  type AuditTemplateVersion,
  copyAuditTemplate,
  getAuditTemplate,
  getAuditTemplateVersion,
  listAuditTemplateVersions,
  updateAuditTemplate,
} from "./auditApi";

interface BuilderProps {
  id: string;
  manageGlobal?: boolean;
  onNavigate: (pathname: string) => void;
}

export function AuditTemplateBuilder({
  id,
  manageGlobal = false,
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
      const copiedGlobal = template.scope === "global" && !manageGlobal;
      const saved = copiedGlobal
        ? await copyAuditTemplate(template)
        : await updateAuditTemplate(template);
      setTemplate(saved);
      setNotice(
        copiedGlobal
          ? "Organization form created. The global form is unchanged."
          : `Version ${saved.version} saved.`,
      );
      if (saved.id !== id) {
        onNavigate(`/audits/templates/${encodeURIComponent(saved.id)}`);
      }
      setVersions(await listAuditTemplateVersions(saved.id));
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

  return (
    <Page>
      <BuilderHeader
        busy={busy}
        manageGlobal={manageGlobal}
        onBack={() => onNavigate("/audits")}
        onSave={save}
        onVersionChange={selectVersion}
        template={template}
        versions={versions ?? []}
      />
      <BuilderBody
        error={error}
        manageGlobal={manageGlobal}
        notice={notice}
        onChange={(nextTemplate) => {
          setTemplate(nextTemplate);
          setNotice(undefined);
        }}
        template={template}
      />
    </Page>
  );
}

function BuilderBody({
  error,
  manageGlobal,
  notice,
  onChange,
  template,
}: {
  error: string | undefined;
  manageGlobal: boolean;
  notice: string | undefined;
  onChange: (template: AuditTemplate) => void;
  template: AuditTemplate;
}) {
  const sections = template.definition.sections;
  const updateSections = (nextSections: AuditTemplateSection[]) =>
    onChange({
      ...template,
      definition: { ...template.definition, sections: nextSections },
    });
  return (
    <PageBody>
      <BuilderNotices
        error={error}
        manageGlobal={manageGlobal}
        notice={notice}
        template={template}
      />
      <fieldset className="fieldset auditBuilderFields">
        <TemplateDetails template={template} update={onChange} />
        <div className="stack">
          <div className="sectionHeader">
            <h2 className="sectionTitle">Sections</h2>
            <span className="sectionCount">
              {countLabel(sections.length, "section")} ·{" "}
              {countLabel(questionCount(sections), "question")}
            </span>
          </div>
          {sections.map((section, index) => (
            <SectionEditor
              canRemove={sections.length > 1}
              index={index}
              key={section.id}
              onChange={(nextSection) =>
                updateSections(replaceById(sections, nextSection))
              }
              onRemove={() =>
                updateSections(
                  sections.filter((candidate) => candidate.id !== section.id),
                )
              }
              section={section}
            />
          ))}
          <Button
            block
            className="auditAddButton"
            icon="add"
            onClick={() => updateSections([...sections, newSection()])}
          >
            Add section
          </Button>
        </div>
      </fieldset>
    </PageBody>
  );
}

function BuilderNotices({
  error,
  manageGlobal,
  notice,
  template,
}: {
  error: string | undefined;
  manageGlobal: boolean;
  notice: string | undefined;
  template: AuditTemplate;
}) {
  const isGlobal = template.scope === "global";
  return (
    <>
      {error && <Banner tone="danger">{error}</Banner>}
      {notice && <Banner tone="success">{notice}</Banner>}
      {isGlobal && !manageGlobal && (
        <Banner announce={false} icon="copy" tone="info">
          Changes will be saved as a new form for this organization. The global
          form and its version history will stay unchanged.
        </Banner>
      )}
      {isGlobal && manageGlobal && (
        <Banner announce={false} tone="warning">
          You are managing the shared global form. Saving will publish a new
          version for every organization.
        </Banner>
      )}
      {template.version < template.currentVersion && (
        <Banner announce={false} icon="layers" tone="neutral">
          {template.scope === "organization" || manageGlobal ? (
            <>
              You are viewing version {template.version}. Saving changes will
              create version {template.currentVersion + 1}; this version will
              stay unchanged.
            </>
          ) : (
            <>
              You are using global version {template.version} as the starting
              point. The latest global version is {template.currentVersion}.
            </>
          )}
        </Banner>
      )}
    </>
  );
}

function BuilderHeader({
  busy,
  manageGlobal,
  onBack,
  onSave,
  onVersionChange,
  template,
  versions,
}: {
  busy: boolean;
  manageGlobal: boolean;
  onBack: () => void;
  onSave: () => Promise<void>;
  onVersionChange: (version: number) => Promise<void>;
  template: AuditTemplate;
  versions: AuditTemplateVersion[];
}) {
  const customizing = template.scope === "global" && !manageGlobal;
  return (
    <PageHeader
      actions={
        <div className="auditVersionControls">
          <label className="auditVersionPicker">
            <span className="auditVersionLabel">Version</span>
            <select
              className="select auditVersionSelect"
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
          <Button
            busy={busy}
            icon="check"
            onClick={() => void onSave()}
            variant="primary"
          >
            {busy
              ? "Saving…"
              : customizing
                ? "Save organization copy"
                : `Save as version ${template.currentVersion + 1}`}
          </Button>
        </div>
      }
      back={<BackButton onBack={onBack} />}
      eyebrow={
        <>
          {template.scope === "global" ? "Global form" : "Organization form"}
          {" · "}Version {template.version} of {template.currentVersion}
        </>
      }
      title={customizing ? "Customize template" : "Edit template"}
    />
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <Button
      className="auditBack"
      icon="arrowLeft"
      onClick={onBack}
      size="sm"
      variant="ghost"
    >
      Audits
    </Button>
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
    <Card title="Details">
      <div className="formGrid">
        <Field label="Checklist name">
          <input
            className="input"
            maxLength={200}
            onChange={(event) =>
              update({ ...template, name: event.target.value })
            }
            required
            value={template.name}
          />
        </Field>
        <Field label="Description" optional>
          <textarea
            className="textarea auditDescriptionInput"
            maxLength={2000}
            onChange={(event) =>
              update({ ...template, description: event.target.value })
            }
            placeholder="What should an auditor know before starting?"
            rows={3}
            value={template.description}
          />
        </Field>
      </div>
    </Card>
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
    <article className="card auditSectionCard">
      <header className="auditSectionHeader">
        <span aria-hidden="true" className="auditSectionNumber">
          {String(index + 1).padStart(2, "0")}
        </span>
        <input
          aria-label={`Section ${index + 1} title`}
          className="input auditSectionTitle"
          maxLength={200}
          onChange={(event) =>
            onChange({ ...section, title: event.target.value })
          }
          value={section.title}
        />
        <Button
          aria-label={`Remove section ${index + 1}`}
          className="auditRemoveButton"
          disabled={!canRemove}
          icon="trash"
          iconOnly
          onClick={onRemove}
          size="sm"
          title="Remove section"
          variant="ghost"
        />
      </header>
      {section.items.length > 0 ? (
        <div>
          {section.items.map((item, itemIndex) => (
            <QuestionEditor
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
      ) : (
        <EmptyState
          className="auditQuestionEmpty"
          compact
          icon="checklist"
          plain
          title="No questions in this section"
        />
      )}
      <div className="auditSectionFooter">
        <Button
          block
          className="auditAddButton"
          icon="add"
          onClick={() =>
            onChange({ ...section, items: [...section.items, newItem()] })
          }
          size="sm"
        >
          Add question
        </Button>
      </div>
    </article>
  );
}

function QuestionEditor({
  index,
  item,
  onChange,
  onRemove,
}: {
  index: number;
  item: AuditTemplateItem;
  onChange: (item: AuditTemplateItem) => void;
  onRemove: () => void;
}) {
  return (
    <div className="auditQuestion">
      <span aria-hidden="true" className="auditQuestionNumber">
        {index + 1}
      </span>
      <textarea
        aria-label={`Question ${index + 1}`}
        className="textarea auditQuestionPrompt"
        maxLength={500}
        onChange={(event) => onChange({ ...item, prompt: event.target.value })}
        rows={2}
        value={item.prompt}
      />
      <div className="auditQuestionControls">
        <select
          aria-label="Response type"
          className="select inputSm auditResponseType"
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
        <label className="check auditRequired">
          <input
            checked={item.required}
            onChange={(event) =>
              onChange({ ...item, required: event.target.checked })
            }
            type="checkbox"
          />
          Required
        </label>
      </div>
      <Button
        aria-label={`Delete question ${index + 1}`}
        className="auditRemoveButton auditQuestionRemove"
        icon="trash"
        iconOnly
        onClick={onRemove}
        size="sm"
        title="Delete question"
        variant="ghost"
      />
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
  const returnButton = (
    <Button
      icon="arrowLeft"
      onClick={onBack}
      size={error ? "sm" : "md"}
      variant={error ? "secondary" : "ghost"}
    >
      Return to audits
    </Button>
  );
  return (
    <Page>
      <PageBody>
        {error ? (
          <Banner actions={returnButton} tone="danger">
            {error}
          </Banner>
        ) : (
          <div className="auditBuilderState">
            <LoadingState label="Loading checklist…" />
            {returnButton}
          </div>
        )}
      </PageBody>
    </Page>
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

function questionCount(sections: AuditTemplateSection[]) {
  return sections.reduce((count, section) => count + section.items.length, 0);
}

function countLabel(count: number, noun: string) {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

function formatVersionDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(value),
  );
}

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not save checklist.";
}
