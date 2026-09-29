import {
  Badge,
  type BadgeTone,
  Banner,
  Button,
  buttonClass,
  Card,
  cx,
  EmptyState,
  Field,
  Icon,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
} from "@tearleads/ui/react";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import {
  AuditApiError,
  type AuditDefinition,
  type AuditDetail,
  type AuditIssue,
  type AuditRun,
  type AuditTemplateItem,
  type AuditTemplateSection,
  auditIssueImageUrl,
  createAuditIssue,
  deleteAuditIssueImage,
  getAuditRun,
  type OrganizationMember,
  saveAuditRun,
  updateAuditIssue,
  uploadAuditIssueImage,
} from "./auditApi";
import { countLabel, formatLabel } from "./labels";

const acceptedImageTypes = [
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
];
const maxIssueImages = 10;
const maxIssueImageBytes = 10 * 1024 * 1024;

const checkResponses = ["pass", "fail", "na"] as const;

const choiceTone: Record<
  (typeof checkResponses)[number],
  "danger" | "success" | undefined
> = {
  fail: "danger",
  na: undefined,
  pass: "success",
};

const priorityTones: Record<string, BadgeTone> = {
  critical: "danger",
  high: "danger",
  low: "neutral",
  medium: "warning",
};

interface AuditRunPageProps {
  id: string;
  onNavigate: (pathname: string) => void;
}

interface RunState {
  detail: AuditDetail | undefined;
  responses: Record<string, string>;
}

type RunAction =
  | { detail: AuditDetail; type: "loaded" }
  | { detail: AuditDetail; type: "issuesRefreshed" }
  | { itemId: string; response: string; type: "answered" };

/**
 * The run page's audit and answers. Issue changes refresh the audit without
 * discarding unsaved answers, so a Fail survives raising its issue.
 */
export function runStateReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case "loaded":
      return {
        detail: action.detail,
        responses: action.detail.audit.responses,
      };
    case "issuesRefreshed":
      return { ...state, detail: action.detail };
    case "answered":
      return {
        ...state,
        responses: { ...state.responses, [action.itemId]: action.response },
      };
  }
}

export function AuditRunPage({ id, onNavigate }: AuditRunPageProps) {
  const [{ detail, responses }, dispatch] = useReducer(runStateReducer, {
    detail: undefined,
    responses: {},
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const fetchRun = useCallback(
    async (type: "issuesRefreshed" | "loaded") => {
      try {
        dispatch({ detail: await getAuditRun(id), type });
      } catch (cause) {
        setError(messageFrom(cause));
      }
    },
    [id],
  );
  const load = useCallback(() => fetchRun("loaded"), [fetchRun]);
  const refreshIssues = useCallback(
    () => fetchRun("issuesRefreshed"),
    [fetchRun],
  );

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
    <Page>
      <RunHeader
        busy={busy}
        feedback={
          error
            ? { text: error, tone: "danger" }
            : notice
              ? { text: notice, tone: "success" }
              : undefined
        }
        name={detail.audit.templateName}
        onBack={() => onNavigate("/audits")}
        onSave={save}
        status={detail.audit.status}
        templateVersion={detail.audit.templateVersion}
      />
      <PageBody className="runBody">
        {error && <Banner tone="danger">{error}</Banner>}
        {notice && <Banner tone="success">{notice}</Banner>}
        <RunProgress
          audit={detail.audit}
          issues={detail.issues}
          responses={responses}
        />
        <AuditQuestions
          definition={detail.audit.definition}
          issueContext={{
            auditId: id,
            issues: detail.issues,
            members: detail.members,
            onCreated: refreshIssues,
          }}
          onChange={(itemId, response) =>
            dispatch({ itemId, response, type: "answered" })
          }
          responses={responses}
        />
        <IssuePanel
          auditId={id}
          definition={detail.audit.definition}
          issues={detail.issues}
          members={detail.members}
          onChange={refreshIssues}
          responses={responses}
        />
      </PageBody>
    </Page>
  );
}

function RunHeader({
  busy,
  feedback,
  name,
  onBack,
  onSave,
  status,
  templateVersion,
}: {
  busy: boolean;
  /** Mirrors the save result inside the phone action bar; the banners announce it. */
  feedback: { text: string; tone: "danger" | "success" } | undefined;
  name: string;
  onBack: () => void;
  onSave: (status: "completed" | "in_progress") => Promise<void>;
  status: string;
  templateVersion: number | null;
}) {
  return (
    <PageHeader
      actions={
        <div className="runActions">
          {feedback && (
            <p
              aria-hidden="true"
              className={cx(
                "runActionsFeedback",
                feedback.tone === "danger" && "runActionsFeedbackDanger",
              )}
            >
              {feedback.text}
            </p>
          )}
          <Button disabled={busy} onClick={() => void onSave("in_progress")}>
            Save draft
          </Button>
          <Button
            disabled={busy}
            icon="check"
            onClick={() => void onSave("completed")}
            variant="primary"
          >
            Complete audit
          </Button>
        </div>
      }
      back={<RunBackButton onBack={onBack} />}
      eyebrow={
        <>
          <span>Audit</span>
          <Badge dot tone={status === "completed" ? "success" : "warning"}>
            {formatLabel(status)}
          </Badge>
          {templateVersion ? <span>Template v{templateVersion}</span> : null}
        </>
      }
      title={name}
    />
  );
}

function RunBackButton({ onBack }: { onBack: () => void }) {
  return (
    <Button
      className="runBack"
      icon="arrowLeft"
      onClick={onBack}
      size="sm"
      variant="ghost"
    >
      Audits
    </Button>
  );
}

function RunProgress({
  audit,
  issues,
  responses,
}: {
  audit: AuditRun;
  issues: AuditIssue[];
  responses: Record<string, string>;
}) {
  const { answered, failed, requiredLeft, total } = useMemo(
    () => progressFor(audit.definition, responses),
    [audit.definition, responses],
  );
  // Floor, so the bar never reads 100% while a question is unanswered.
  const percent = total ? Math.floor((answered / total) * 100) : 0;
  const openIssues = issues.filter((issue) => issue.status === "open").length;
  return (
    <Card>
      <div className="runProgressLayout">
        <div className="runProgressMain">
          <div className="runProgressHeading">
            <p className="runProgressValue">
              {answered} of {total} answered
            </p>
            <span className="runProgressPercent">{percent}%</span>
          </div>
          <div aria-hidden="true" className="runProgressTrack">
            <span
              className="runProgressFill"
              style={{ width: `${percent}%` }}
            />
          </div>
          <ProgressNote audit={audit} requiredLeft={requiredLeft} />
        </div>
        <dl className="runStats">
          <div className={cx(failed > 0 && "runStatDanger")}>
            <dt>Failed</dt>
            <dd>{failed}</dd>
          </div>
          <div>
            <dt>Open issues</dt>
            <dd>{openIssues}</dd>
          </div>
        </dl>
      </div>
    </Card>
  );
}

function ProgressNote({
  audit,
  requiredLeft,
}: {
  audit: AuditRun;
  requiredLeft: number;
}) {
  if (audit.status === "completed") {
    return (
      <p className="runProgressNote runProgressDone">
        <Icon name="success" size={16} />
        <span>
          Completed
          {audit.completedAt ? ` ${formatDate(audit.completedAt)}` : ""}
          <span className="runProgressHint"> · Saving a draft reopens it.</span>
        </span>
      </p>
    );
  }
  return (
    <p className="runProgressNote">
      {requiredLeft > 0
        ? `${countLabel(requiredLeft, "required question")} left before this audit can be completed.`
        : "All required questions are answered."}
    </p>
  );
}

/** What a question needs to raise an issue inline when it is marked Fail. */
interface IssueContext {
  auditId: string;
  issues: AuditIssue[];
  members: OrganizationMember[];
  onCreated: () => Promise<void>;
}

function AuditQuestions({
  definition,
  issueContext,
  onChange,
  responses,
}: {
  definition: AuditDefinition;
  issueContext: IssueContext;
  onChange: (itemId: string, response: string) => void;
  responses: Record<string, string>;
}) {
  const total = allItems(definition).length;
  return (
    <PageSection
      actions={
        <span className="sectionCount">{countLabel(total, "question")}</span>
      }
      title="Checklist"
    >
      <div className="runSections">
        {definition.sections.map((section, sectionIndex) => (
          <AuditSection
            index={sectionIndex}
            issueContext={issueContext}
            key={section.id}
            onChange={onChange}
            responses={responses}
            section={section}
          />
        ))}
      </div>
    </PageSection>
  );
}

function AuditSection({
  index,
  issueContext,
  onChange,
  responses,
  section,
}: {
  index: number;
  issueContext: IssueContext;
  onChange: (itemId: string, response: string) => void;
  responses: Record<string, string>;
  section: AuditTemplateSection;
}) {
  const answered = section.items.filter((item) =>
    isAnswered(responses[item.id]),
  ).length;
  const empty = section.items.length === 0;
  const done = !empty && answered === section.items.length;
  return (
    <Card
      actions={
        <span
          className={cx(
            "sectionCount runSectionCount",
            done && "runSectionDone",
          )}
        >
          {done && <Icon name="check" size={16} />}
          {empty
            ? "No questions"
            : `${answered}/${section.items.length} answered`}
        </span>
      }
      className="runSection"
      flush
      title={
        <span className="runSectionTitle">
          <span className="runSectionNumber">
            {String(index + 1).padStart(2, "0")}
          </span>
          {section.title}
        </span>
      }
    >
      {empty ? undefined : (
        <ol className="rowList">
          {section.items.map((item, itemIndex) => (
            <AuditQuestion
              index={itemIndex}
              issueContext={issueContext}
              item={item}
              key={item.id}
              onChange={(response) => onChange(item.id, response)}
              response={responses[item.id] ?? ""}
            />
          ))}
        </ol>
      )}
    </Card>
  );
}

function AuditQuestion({
  index,
  issueContext,
  item,
  onChange,
  response,
}: {
  index: number;
  issueContext: IssueContext;
  item: AuditTemplateItem;
  onChange: (response: string) => void;
  response: string;
}) {
  const promptId = `audit-item-${item.id}`;
  const [issueState, dispatchIssue] = useReducer(failIssueReducer, {
    offer: 0,
    step: "closed",
  });
  return (
    <li
      className={cx(
        "row runQuestion",
        item.responseType !== "check" && "runQuestionWritten",
        response === "fail" && "runQuestionFailed",
      )}
    >
      <div className="runQuestionBody">
        <span className="runQuestionNumber">{index + 1}</span>
        <div className="runQuestionCopy">
          <p className="runQuestionPrompt" id={promptId}>
            {item.prompt}
          </p>
          {item.required && <span className="runRequired">Required</span>}
        </div>
      </div>
      {item.responseType === "check" ? (
        <ResponseChoices
          labelledBy={promptId}
          onChange={(next) => {
            dispatchIssue({ next, previous: response, type: "answered" });
            onChange(next);
          }}
          response={response}
        />
      ) : (
        <textarea
          aria-labelledby={promptId}
          className="textarea runAnswer"
          maxLength={2000}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Enter response"
          rows={3}
          value={response}
        />
      )}
      {issueState.step !== "closed" && response === "fail" && (
        <FailedItemIssue
          auditId={issueContext.auditId}
          item={item}
          key={issueState.offer}
          members={issueContext.members}
          onCreated={async (offer, warning) => {
            dispatchIssue({ offer, type: "created", warning });
            await issueContext.onCreated();
          }}
          onSkipChange={(skip) => dispatchIssue({ skip, type: "skipToggled" })}
          openIssueCount={
            issueContext.issues.filter(
              (issue) => issue.itemId === item.id && issue.status === "open",
            ).length
          }
          state={issueState}
        />
      )}
    </li>
  );
}

/**
 * The inline issue beneath a checklist item. `offer` counts fresh Fail clicks
 * so a submission can be matched to the form it came from.
 */
export type FailIssueState =
  | { offer: number; step: "closed" }
  | { offer: number; step: "offered" }
  | { offer: number; step: "skipped" }
  | { offer: number; step: "created"; warning: string | undefined };

type FailIssueEvent =
  | { next: string; previous: string; type: "answered" }
  | { skip: boolean; type: "skipToggled" }
  | { offer: number; type: "created"; warning: string | undefined };

/**
 * Only a fresh Fail click offers the issue, so failures reloaded from a saved
 * draft keep the checklist compact. Any other answer closes it.
 */
export function failIssueReducer(
  state: FailIssueState,
  event: FailIssueEvent,
): FailIssueState {
  switch (event.type) {
    case "answered":
      if (event.next === event.previous) return state;
      return event.next === "fail"
        ? { offer: state.offer + 1, step: "offered" }
        : { offer: state.offer, step: "closed" };
    case "skipToggled":
      if (state.step !== "offered" && state.step !== "skipped") return state;
      return { offer: state.offer, step: event.skip ? "skipped" : "offered" };
    case "created":
      // A submission that outlived its offer must not replace a newer form.
      if (event.offer !== state.offer || state.step === "closed") return state;
      return { offer: state.offer, step: "created", warning: event.warning };
  }
}

/**
 * The issue offered beneath a freshly failed item. The checkbox records a
 * deliberate failure with no follow-up and tucks the form away.
 */
export function FailedItemIssue({
  auditId,
  item,
  members,
  onCreated,
  onSkipChange,
  openIssueCount,
  state,
}: {
  auditId: string;
  item: AuditTemplateItem;
  members: OrganizationMember[];
  onCreated: (offer: number, warning?: string) => Promise<void>;
  onSkipChange: (skip: boolean) => void;
  openIssueCount: number;
  state: Exclude<FailIssueState, { step: "closed" }>;
}) {
  const draft = useIssueDraft(auditId, item);

  if (state.step === "created") {
    return (
      <p className="runFailIssueCreated" role="status">
        <Icon name="success" size={16} />
        <span>
          Issue created.
          {state.warning ? ` ${state.warning}` : ""}
        </span>
      </p>
    );
  }

  return (
    <section aria-label="Issue for this failure" className="runFailIssue">
      <label className="check">
        <input
          checked={state.step === "skipped"}
          disabled={draft.busy}
          onChange={(event) => onSkipChange(event.target.checked)}
          type="checkbox"
        />
        Fail without creating issue
      </label>
      {state.step === "offered" && (
        <>
          {openIssueCount > 0 && (
            <p className="fieldHint">
              This item already has {countLabel(openIssueCount, "open issue")}.
            </p>
          )}
          {draft.error && <Banner tone="danger">{draft.error}</Banner>}
          <IssueDraftFields draft={draft} members={members} />
          <div className="formActions">
            <Button
              busy={draft.busy}
              className="runIssueSubmit"
              disabled={!draft.title.trim()}
              icon="add"
              onClick={() =>
                void draft.submit((warning) => onCreated(state.offer, warning))
              }
              variant="primary"
            >
              {draft.busy ? "Creating…" : "Create issue"}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

function ResponseChoices({
  labelledBy,
  onChange,
  response,
}: {
  labelledBy: string;
  onChange: (response: string) => void;
  response: string;
}) {
  return (
    <fieldset
      aria-labelledby={labelledBy}
      className="segmented segmentedFill runChoices"
    >
      {checkResponses.map((value) => (
        <button
          aria-pressed={response === value}
          data-tone={choiceTone[value]}
          key={value}
          onClick={() => onChange(value)}
          type="button"
        >
          {value === "na" ? "N/A" : formatLabel(value)}
        </button>
      ))}
    </fieldset>
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
  const [issueError, setIssueError] = useState<string>();
  return (
    <PageSection
      actions={
        <Button
          aria-expanded={showForm}
          icon={showForm ? "close" : "add"}
          onClick={() => setShowForm((current) => !current)}
          variant={showForm ? "ghost" : "secondary"}
        >
          {showForm ? "Cancel" : "Raise issue"}
        </Button>
      }
      description="Track follow-up work discovered during this audit."
      title="Issues"
    >
      {issueError && <Banner tone="danger">{issueError}</Banner>}
      {showForm && (
        <IssueForm
          auditId={auditId}
          items={items}
          members={members}
          onCreated={async (warning) => {
            setShowForm(false);
            setIssueError(warning);
            await onChange();
          }}
          responses={responses}
        />
      )}
      {(issues.length > 0 || !showForm) && (
        <IssueList
          issues={issues}
          members={members}
          onChange={onChange}
          onError={setIssueError}
        />
      )}
    </PageSection>
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
  onCreated: (warning?: string) => Promise<void>;
  responses: Record<string, string>;
}) {
  const suggested =
    items.find((item) => responses[item.id] === "fail") ?? items[0];
  const draft = useIssueDraft(auditId, suggested);

  return (
    <Card
      description="Link the issue to a checklist item and assign follow-up."
      footer={
        <Button
          busy={draft.busy}
          className="runIssueSubmit"
          disabled={!draft.itemId || !draft.title.trim()}
          icon="add"
          onClick={() => void draft.submit(onCreated)}
          variant="primary"
        >
          {draft.busy ? "Creating…" : "Create issue"}
        </Button>
      }
      title="New issue"
    >
      {draft.error && <Banner tone="danger">{draft.error}</Banner>}
      <Field label="Checklist item">
        <select
          className="select"
          onChange={(event) => {
            const nextId = event.target.value;
            draft.setItemId(nextId);
            draft.setTitle(
              items.find((item) => item.id === nextId)?.prompt ?? "",
            );
          }}
          value={draft.itemId}
        >
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {responses[item.id] === "fail" ? "Failed · " : ""}
              {item.prompt}
            </option>
          ))}
        </select>
      </Field>
      <IssueDraftFields draft={draft} members={members} />
    </Card>
  );
}

type IssueDraft = ReturnType<typeof useIssueDraft>;

/** A new issue's fields and its create-then-attach-images submission. */
function useIssueDraft(auditId: string, item: AuditTemplateItem | undefined) {
  const [itemId, setItemId] = useState(item?.id ?? "");
  const [title, setTitle] = useState(item?.prompt ?? "");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("medium");
  const [assignedTo, setAssignedTo] = useState("");
  const [images, setImages] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(onCreated: (warning?: string) => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      const warning = await createIssueWithImages(
        auditId,
        {
          assignedTo: assignedTo || null,
          description,
          itemId,
          priority,
          title,
        },
        images,
      );
      await onCreated(warning);
    } catch (cause) {
      setError(messageFrom(cause));
      setBusy(false);
    }
  }

  return {
    assignedTo,
    busy,
    description,
    error,
    images,
    itemId,
    priority,
    setAssignedTo,
    setDescription,
    setError,
    setImages,
    setItemId,
    setPriority,
    setTitle,
    submit,
    title,
  };
}

function IssueDraftFields({
  draft,
  members,
}: {
  draft: IssueDraft;
  members: OrganizationMember[];
}) {
  return (
    <>
      <Field label="Title">
        <input
          className="input"
          maxLength={300}
          onChange={(event) => draft.setTitle(event.target.value)}
          value={draft.title}
        />
      </Field>
      <Field label="Description" optional>
        <textarea
          className="textarea"
          maxLength={2000}
          onChange={(event) => draft.setDescription(event.target.value)}
          placeholder="Describe the problem, evidence, and expected follow-up."
          rows={3}
          value={draft.description}
        />
      </Field>
      <IssueAssignmentFields
        assignedTo={draft.assignedTo}
        members={members}
        onAssignedToChange={draft.setAssignedTo}
        onPriorityChange={draft.setPriority}
        priority={draft.priority}
      />
      <IssueImagePicker
        files={draft.images}
        onChange={draft.setImages}
        onError={draft.setError}
      />
    </>
  );
}

function IssueImagePicker({
  files,
  onChange,
  onError,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  onError: (error: string | undefined) => void;
}) {
  return (
    <fieldset className="fieldset runImagePicker">
      <legend>
        Images <span className="fieldOptional">Optional</span>
      </legend>
      <div className="runImagePickerControls">
        <label
          className={buttonClass({
            className: "runFilePicker",
            size: "sm",
          })}
        >
          <Icon name="image" size={16} />
          Add images
          <input
            accept={acceptedImageTypes.join(",")}
            className="srOnly"
            multiple
            onChange={(event) => {
              const selected = appendIssueImageSelection(
                files,
                Array.from(event.target.files ?? []),
              );
              if (typeof selected === "string") {
                onError(selected);
                event.target.value = "";
                return;
              }
              onError(undefined);
              onChange(selected);
              event.target.value = "";
            }}
            type="file"
          />
        </label>
        <span className="fieldHint">
          Up to 10 JPEG, PNG, GIF, or WebP images; 10 MB each.
        </span>
      </div>
      <SelectedIssueImages
        files={files}
        onRemove={(file) =>
          onChange(files.filter((candidate) => candidate !== file))
        }
      />
    </fieldset>
  );
}

function IssueAssignmentFields({
  assignedTo,
  members,
  onAssignedToChange,
  onPriorityChange,
  priority,
}: {
  assignedTo: string;
  members: OrganizationMember[];
  onAssignedToChange: (assignedTo: string) => void;
  onPriorityChange: (priority: string) => void;
  priority: string;
}) {
  return (
    <div className="formRow">
      <Field label="Priority">
        <select
          className="select"
          onChange={(event) => onPriorityChange(event.target.value)}
          value={priority}
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="critical">Critical</option>
        </select>
      </Field>
      <Field label="Assignee">
        <select
          className="select"
          onChange={(event) => onAssignedToChange(event.target.value)}
          value={assignedTo}
        >
          <option value="">Unassigned</option>
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name} · {member.email}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

function IssueList({
  issues,
  members,
  onChange,
  onError,
}: {
  issues: AuditIssue[];
  members: OrganizationMember[];
  onChange: () => Promise<void>;
  onError: (error: string | undefined) => void;
}) {
  if (!issues.length) {
    return (
      <EmptyState compact icon="issues" title="No issues raised">
        Raise an issue for anything that needs follow-up after this audit.
      </EmptyState>
    );
  }
  return (
    <Card flush>
      <ul className="rowList">
        {issues.map((issue) => (
          <IssueCard
            issue={issue}
            key={issue.id}
            members={members}
            onChange={onChange}
            onError={onError}
          />
        ))}
      </ul>
    </Card>
  );
}

function IssueCard({
  issue,
  members,
  onChange,
  onError,
}: {
  issue: AuditIssue;
  members: OrganizationMember[];
  onChange: () => Promise<void>;
  onError: (error: string | undefined) => void;
}) {
  const { attach, busy, removeImage, update } = useIssueCardActions({
    issue,
    onChange,
    onError,
  });

  return (
    <li className="row runIssue">
      <div className="rowMain runIssueMain">
        <div className="cluster">
          <Badge tone={priorityTones[issue.priority] ?? "neutral"}>
            {formatLabel(issue.priority)}
          </Badge>
          <Badge dot tone={issue.status === "open" ? "warning" : "success"}>
            {issue.status === "open" ? "Open" : "Resolved"}
          </Badge>
        </div>
        <h3 className="runIssueTitle">{issue.title}</h3>
        {issue.description && (
          <p className="runIssueDescription">{issue.description}</p>
        )}
        <IssueImages
          busy={busy}
          issue={issue}
          onAttach={attach}
          onRemove={removeImage}
        />
      </div>
      <IssueCardActions
        busy={busy}
        issue={issue}
        members={members}
        onUpdate={update}
      />
    </li>
  );
}

function IssueCardActions({
  busy,
  issue,
  members,
  onUpdate,
}: {
  busy: boolean;
  issue: AuditIssue;
  members: OrganizationMember[];
  onUpdate: (update: {
    assignedTo?: string | null;
    status?: "open" | "resolved";
  }) => Promise<void>;
}) {
  const assignedMemberIsMissing =
    Boolean(issue.assignedTo) &&
    !members.some((member) => member.id === issue.assignedTo);
  return (
    <div className="rowActions runIssueActions">
      <label className="runAssignee">
        <span>Assignee</span>
        <select
          className="select inputSm runAssigneeSelect"
          disabled={busy}
          onChange={(event) =>
            void onUpdate({ assignedTo: event.target.value || null })
          }
          value={issue.assignedTo ?? ""}
        >
          <option value="">Unassigned</option>
          {assignedMemberIsMissing && (
            <option disabled value={issue.assignedTo ?? ""}>
              {issue.assigneeName ?? issue.assigneeEmail ?? "Former member"} ·
              no longer a member
            </option>
          )}
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
            </option>
          ))}
        </select>
      </label>
      <Button
        disabled={busy}
        icon={issue.status === "open" ? "check" : "refresh"}
        onClick={() =>
          void onUpdate({
            status: issue.status === "open" ? "resolved" : "open",
          })
        }
        size="sm"
      >
        {issue.status === "open" ? "Resolve" : "Reopen"}
      </Button>
    </div>
  );
}

function useIssueCardActions({
  issue,
  onChange,
  onError,
}: {
  issue: AuditIssue;
  onChange: () => Promise<void>;
  onError: (error: string | undefined) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    onError(undefined);
    try {
      await action();
      await onChange();
    } catch (cause) {
      onError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }

  return {
    attach: async (files: File[]) => {
      const selected = validateImageFiles(
        files,
        maxIssueImages - issue.images.length,
      );
      if (typeof selected === "string") {
        onError(selected);
        return;
      }
      await run(async () => {
        const [failure] = await uploadIssueImagesSequentially(
          issue.id,
          selected,
        );
        if (failure !== undefined) onError(messageFrom(failure));
      });
    },
    busy,
    removeImage: (imageId: string) =>
      run(() => deleteAuditIssueImage(issue.id, imageId)),
    update: (update: {
      assignedTo?: string | null;
      status?: "open" | "resolved";
    }) => run(() => updateAuditIssue(issue.id, update)),
  };
}

type IssueImageUploader = (issueId: string, file: File) => Promise<unknown>;

/**
 * Creates the issue, then attaches its images. Returns a warning when some
 * images could not be attached; the issue exists either way.
 */
export async function createIssueWithImages(
  auditId: string,
  issue: Parameters<typeof createAuditIssue>[1],
  images: File[],
  create: typeof createAuditIssue = createAuditIssue,
  upload: IssueImageUploader = uploadAuditIssueImage,
) {
  const { issueId } = await create(auditId, issue);
  const failedUploads = (
    await uploadIssueImagesSequentially(issueId, images, upload)
  ).length;
  return failedUploads > 0
    ? `${failedUploads} image${failedUploads === 1 ? "" : "s"} could not be attached. The issue was created.`
    : undefined;
}

type WaitForRetry = (milliseconds: number) => Promise<void>;

const maxIssueImageUploadRetries = 9;
const maxIssueImageRetryDelay = 10_000;

export async function uploadIssueImagesSequentially(
  issueId: string,
  files: File[],
  upload: IssueImageUploader = uploadAuditIssueImage,
  wait: WaitForRetry = waitForRetry,
) {
  const failures: unknown[] = [];
  // Keep at most one decoded upload in a Worker isolate for this browser. A
  // user can select ten 10 MB files, so firing them all at once can exhaust the
  // isolate's shared memory before image normalization completes.
  for (const file of files) {
    let retryAttempt = 0;
    while (true) {
      try {
        await upload(issueId, file);
        break;
      } catch (retryCause) {
        const retryDelay = issueImageRetryDelay(retryCause, retryAttempt);
        if (
          retryDelay === undefined ||
          retryAttempt >= maxIssueImageUploadRetries
        ) {
          failures.push(retryCause);
          break;
        }
        retryAttempt += 1;
        await wait(retryDelay);
      }
    }
  }
  return failures;
}

function issueImageRetryDelay(cause: unknown, retryAttempt: number) {
  if (!(cause instanceof AuditApiError) || cause.response.status !== 429) {
    return undefined;
  }
  const header = cause.response.headers.get("retry-after");
  if (header === null) return undefined;
  const seconds = /^\d+$/.test(header) ? Number(header) : undefined;
  const milliseconds =
    seconds === undefined ? Date.parse(header) - Date.now() : seconds * 1_000;
  if (!Number.isFinite(milliseconds)) return undefined;
  const exponentialDelay = Math.min(
    1_000 * 2 ** retryAttempt,
    maxIssueImageRetryDelay,
  );
  return Math.min(
    Math.max(milliseconds, exponentialDelay),
    maxIssueImageRetryDelay,
  );
}

function waitForRetry(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function IssueImages({
  busy,
  issue,
  onAttach,
  onRemove,
}: {
  busy: boolean;
  issue: AuditIssue;
  onAttach: (files: File[]) => Promise<void>;
  onRemove: (imageId: string) => Promise<void>;
}) {
  return (
    <div className="runIssueImages">
      {issue.images.length > 0 && (
        <ul className="runThumbs">
          {issue.images.map((image) => (
            <li className="runThumb" key={image.id}>
              <a
                className="runThumbLink"
                href={auditIssueImageUrl(issue.id, image.id)}
                rel="noreferrer"
                target="_blank"
              >
                <img
                  alt={image.filename}
                  className="runThumbImage"
                  decoding="async"
                  loading="lazy"
                  src={auditIssueImageUrl(issue.id, image.id, "thumbnail")}
                />
              </a>
              <Button
                aria-label={`Remove ${image.filename}`}
                className="runThumbRemove"
                disabled={busy}
                icon="close"
                iconOnly
                onClick={() => void onRemove(image.id)}
                size="sm"
              />
            </li>
          ))}
        </ul>
      )}
      {issue.images.length < maxIssueImages && (
        <label
          className={buttonClass({
            className: "runFilePicker runAttach",
            size: "sm",
            variant: "ghost",
          })}
        >
          <Icon name="attachment" size={16} />
          Attach images
          <input
            accept={acceptedImageTypes.join(",")}
            className="srOnly"
            disabled={busy}
            multiple
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              void onAttach(files);
            }}
            type="file"
          />
        </label>
      )}
    </div>
  );
}

function SelectedIssueImages({
  files,
  onRemove,
}: {
  files: File[];
  onRemove: (file: File) => void;
}) {
  if (files.length === 0) return null;
  return (
    <ul className="runThumbs">
      {files.map((file) => (
        <SelectedIssueImage
          file={file}
          key={issueImageSelectionKey(file)}
          onRemove={() => onRemove(file)}
        />
      ))}
    </ul>
  );
}

function SelectedIssueImage({
  file,
  onRemove,
}: {
  file: File;
  onRemove: () => void;
}) {
  const preview = useObjectUrl(file);
  return (
    <li className="runThumb">
      {preview ? (
        <img alt="" className="runThumbImage" src={preview} />
      ) : (
        <span className="runThumbImage runThumbPlaceholder">
          <Icon name="image" />
        </span>
      )}
      <span className="runThumbName" title={file.name}>
        {file.name}
      </span>
      <Button
        aria-label={`Remove ${file.name}`}
        className="runThumbRemove"
        icon="close"
        iconOnly
        onClick={onRemove}
        size="sm"
      />
    </li>
  );
}

/** A preview URL for a picked file, released when the file leaves the form. */
function useObjectUrl(file: File) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url;
}

function RunLoading({
  error,
  onBack,
}: {
  error: string | undefined;
  onBack: () => void;
}) {
  return (
    <Page>
      <PageHeader
        back={<RunBackButton onBack={onBack} />}
        eyebrow="Audit"
        title={error ? "Audit unavailable" : "Audit"}
      />
      <PageBody>
        {error ? (
          <Banner
            actions={
              <Button onClick={onBack} size="sm">
                Return to audits
              </Button>
            }
            tone="danger"
          >
            {error}
          </Banner>
        ) : (
          <LoadingState label="Loading audit…" />
        )}
      </PageBody>
    </Page>
  );
}

function allItems(definition: AuditDefinition) {
  return definition.sections.flatMap((section) => section.items);
}

/** Answered, failed, and required-remaining counts shown above the checklist. */
export function progressFor(
  definition: AuditDefinition,
  responses: Record<string, string>,
) {
  const items = allItems(definition);
  const unanswered = items.filter((item) => !isAnswered(responses[item.id]));
  return {
    answered: items.length - unanswered.length,
    failed: items.filter((item) => responses[item.id] === "fail").length,
    requiredLeft: unanswered.filter((item) => item.required).length,
    total: items.length,
  };
}

function isAnswered(response: string | undefined) {
  return Boolean(response?.trim());
}

function validateImageFiles(files: File[], availableSlots: number) {
  if (files.length > availableSlots) {
    return `You can attach ${Math.max(availableSlots, 0)} more image${availableSlots === 1 ? "" : "s"}.`;
  }
  if (
    files.some(
      (file) =>
        file.type && !acceptedImageTypes.includes(file.type.toLowerCase()),
    )
  ) {
    return "Images must be JPEG, PNG, GIF, or WebP files.";
  }
  if (files.some((file) => file.size > maxIssueImageBytes)) {
    return "Images must be 10 MB or smaller.";
  }
  return files;
}

export function appendIssueImageSelection(
  existingFiles: File[],
  selectedFiles: File[],
) {
  const identities = new Set(existingFiles.map(issueImageSelectionKey));
  const additions = selectedFiles.filter((file) => {
    const identity = issueImageSelectionKey(file);
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
  });
  const validated = validateImageFiles(
    additions,
    maxIssueImages - existingFiles.length,
  );
  return typeof validated === "string"
    ? validated
    : [...existingFiles, ...validated];
}

function issueImageSelectionKey(file: File) {
  return JSON.stringify([
    file.name,
    file.size,
    file.lastModified,
    file.type,
    file.webkitRelativePath,
  ]);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(value),
  );
}

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not update audit.";
}
