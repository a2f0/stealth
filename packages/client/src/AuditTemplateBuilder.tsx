import {
  Banner,
  Button,
  Card,
  ContextMenu,
  cx,
  EmptyState,
  Field,
  Icon,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
} from "@tearleads/ui/react";
import { type ReactNode, useEffect, useState } from "react";
import { ActivityFeed } from "./ActivityFeed";
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
import { ErrorBanner, type ErrorNotice, errorNotice } from "./BillingLink";
import { countLabel } from "./labels";
import { moveEntry, useReorderDrag } from "./useReorderDrag";

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
  const [error, setError] = useState<ErrorNotice>();
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    Promise.all([getAuditTemplate(id), listAuditTemplateVersions(id)])
      .then(([nextTemplate, nextVersions]) => {
        setTemplate(nextTemplate);
        setVersions(nextVersions);
      })
      .catch((cause: unknown) =>
        setError(errorNotice(cause, "Could not save checklist.")),
      );
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
      setError(errorNotice(cause, "Could not save checklist."));
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
      setError(errorNotice(cause, "Could not save checklist."));
    } finally {
      setBusy(false);
    }
  }

  if (!template) {
    return (
      <BuilderLoading
        error={error?.message}
        onBack={() => onNavigate("/audits")}
      />
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
        onNavigate={onNavigate}
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
  onNavigate,
  template,
}: {
  error: ErrorNotice | undefined;
  manageGlobal: boolean;
  notice: string | undefined;
  onChange: (template: AuditTemplate) => void;
  onNavigate: (pathname: string) => void;
  template: AuditTemplate;
}) {
  const sections = template.definition.sections;
  const updateSections = (nextSections: AuditTemplateSection[]) =>
    onChange({
      ...template,
      definition: { ...template.definition, sections: nextSections },
    });
  const moveSection = (from: number, to: number, focus: FocusTarget) => {
    const moved = sections[from];
    if (!moved || to < 0 || to >= sections.length) return;
    updateSections(moveEntry(sections, from, to));
    refocus(focus, moved.id);
  };
  const sectionDrag = useReorderDrag(sections.length, (from, to) =>
    moveSection(from, to, "handle"),
  );
  return (
    <PageBody>
      <BuilderNotices
        error={error}
        manageGlobal={manageGlobal}
        notice={notice}
        onNavigate={onNavigate}
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
              count={sections.length}
              entry={sectionDrag.entryState(index)}
              handle={sectionDrag.handleProps(index)}
              index={index}
              key={section.id}
              onShift={(step) => moveSection(index, index + step, "number")}
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
      <ActivityFeed
        refreshKey={template.currentVersion}
        source={{ id: template.id, type: "audit_template" }}
      />
    </PageBody>
  );
}

function BuilderNotices({
  error,
  manageGlobal,
  notice,
  onNavigate,
  template,
}: {
  error: ErrorNotice | undefined;
  manageGlobal: boolean;
  notice: string | undefined;
  onNavigate: (pathname: string) => void;
  template: AuditTemplate;
}) {
  const isGlobal = template.scope === "global";
  return (
    <>
      <ErrorBanner error={error} onNavigate={onNavigate} />
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
  count,
  entry,
  handle,
  index,
  onChange,
  onRemove,
  onShift,
  section,
}: ReorderableProps & {
  canRemove: boolean;
  onChange: (section: AuditTemplateSection) => void;
  onRemove: () => void;
  section: AuditTemplateSection;
}) {
  const updateItem = (item: AuditTemplateItem) =>
    onChange({ ...section, items: replaceById(section.items, item) });
  const moveQuestion = (from: number, to: number, focus: FocusTarget) => {
    const moved = section.items[from];
    if (!moved || to < 0 || to >= section.items.length) return;
    onChange({ ...section, items: moveEntry(section.items, from, to) });
    refocus(focus, moved.id);
  };
  const questionDrag = useReorderDrag(section.items.length, (from, to) =>
    moveQuestion(from, to, "handle"),
  );
  const label = `Section ${index + 1}`;
  return (
    <article {...entryProps(entry, "card auditSectionCard")}>
      <header className="auditSectionHeader">
        <ReorderHandle entryId={section.id} handle={handle} label={label} />
        <PositionMenu
          className="auditSectionNumber"
          count={count}
          entryId={section.id}
          index={index}
          label={label}
          onShift={onShift}
        >
          {String(index + 1).padStart(2, "0")}
        </PositionMenu>
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
              count={section.items.length}
              entry={questionDrag.entryState(itemIndex)}
              handle={questionDrag.handleProps(itemIndex)}
              index={itemIndex}
              item={item}
              key={item.id}
              onChange={updateItem}
              onShift={(step) =>
                moveQuestion(itemIndex, itemIndex + step, "number")
              }
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
  count,
  entry,
  handle,
  index,
  item,
  onChange,
  onRemove,
  onShift,
}: ReorderableProps & {
  item: AuditTemplateItem;
  onChange: (item: AuditTemplateItem) => void;
  onRemove: () => void;
}) {
  const label = `Question ${index + 1}`;
  return (
    <div {...entryProps(entry, "auditQuestion")}>
      <ReorderHandle entryId={item.id} handle={handle} label={label} />
      <PositionMenu
        className="auditQuestionNumber"
        count={count}
        entryId={item.id}
        index={index}
        label={label}
        onShift={onShift}
      >
        {index + 1}
      </PositionMenu>
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

type ReorderDrag = ReturnType<typeof useReorderDrag>;

interface ReorderableProps {
  count: number;
  entry: ReturnType<ReorderDrag["entryState"]>;
  handle: ReturnType<ReorderDrag["handleProps"]>;
  index: number;
  /** Moves the entry one place up (-1) or down (1). */
  onShift: (step: -1 | 1) => void;
}

type FocusTarget = "handle" | "number";

/**
 * Moving an entry re-inserts its element, which drops focus. Put focus back
 * on the control that moved it once the new order is drawn.
 */
function refocus(target: FocusTarget, entryId: string) {
  const key = `${target}-${entryId}`;
  requestAnimationFrame(() => {
    // Compared, not interpolated into a selector, so any ID is safe.
    for (const element of document.querySelectorAll<HTMLElement>(
      "[data-reorder-focus]",
    )) {
      if (element.getAttribute("data-reorder-focus") === key) element.focus();
    }
  });
}

/** Marks a reorderable entry, and shows it lifted or as the drop point. */
function entryProps(
  entry: ReturnType<ReorderDrag["entryState"]>,
  className: string,
) {
  return {
    className: cx(
      className,
      "auditReorderEntry",
      entry.dragging && "auditDragging",
      entry.drop === "before" && "auditDropBefore",
      entry.drop === "after" && "auditDropAfter",
    ),
    "data-reorder-item": "",
    style: entry.dragging
      ? { transform: `translateY(${entry.offset}px)` }
      : undefined,
  };
}

/** Drags the entry; the arrow keys move it one place at a time too. */
function ReorderHandle({
  entryId,
  handle,
  label,
}: {
  entryId: string;
  handle: ReturnType<ReorderDrag["handleProps"]>;
  label: string;
}) {
  return (
    <button
      {...handle}
      aria-label={`Reorder ${label.toLowerCase()}`}
      className="auditDragHandle"
      data-reorder-focus={`handle-${entryId}`}
      title="Drag, or use the arrow keys, to reorder"
      type="button"
    >
      <Icon name="drag" size={16} />
    </button>
  );
}

/** The entry's number, which opens Move up and Move down. */
function PositionMenu({
  children,
  className,
  count,
  entryId,
  index,
  label,
  onShift,
}: {
  children: ReactNode;
  className: string;
  count: number;
  entryId: string;
  index: number;
  label: string;
  onShift: (step: -1 | 1) => void;
}) {
  return (
    <ContextMenu
      items={[
        {
          disabled: index === 0,
          icon: "arrowUp",
          id: "up",
          label: "Move up",
          onSelect: () => onShift(-1),
        },
        {
          disabled: index === count - 1,
          icon: "arrowDown",
          id: "down",
          label: "Move down",
          onSelect: () => onShift(1),
        },
      ]}
      label={`${label} order`}
      openOnClick
    >
      {(props) => (
        <button
          {...props}
          aria-haspopup="menu"
          aria-label={`${label} order`}
          className={className}
          data-reorder-focus={`number-${entryId}`}
          type="button"
        >
          {children}
        </button>
      )}
    </ContextMenu>
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

function formatVersionDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(value),
  );
}
