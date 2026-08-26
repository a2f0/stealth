import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AuditApiError,
  type AuditDefinition,
  type AuditDetail,
  type AuditIssue,
  type AuditTemplateItem,
  auditIssueImageUrl,
  createAuditIssue,
  deleteAuditIssueImage,
  getAuditRun,
  type OrganizationMember,
  saveAuditRun,
  updateAuditIssue,
  uploadAuditIssueImage,
} from "./auditApi";

const acceptedImageTypes = [
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
];
const maxIssueImages = 10;
const maxIssueImageBytes = 10 * 1024 * 1024;

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
        templateVersion={detail.audit.templateVersion}
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
  templateVersion,
}: {
  busy: boolean;
  name: string;
  onBack: () => void;
  onSave: (status: "completed" | "in_progress") => Promise<void>;
  status: string;
  templateVersion: number | null;
}) {
  return (
    <header className="topbar auditEditorTopbar">
      <div>
        <button className="auditBack" onClick={onBack} type="button">
          ← Audits
        </button>
        <p className="eyebrow">
          Audit · {status.replace("_", " ")}
          {templateVersion ? ` · Template v${templateVersion}` : ""}
        </p>
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
  const [issueError, setIssueError] = useState<string>();
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
      {issueError && <div className="errorBanner">{issueError}</div>}
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
      <IssueList
        issues={issues}
        members={members}
        onChange={onChange}
        onError={setIssueError}
      />
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
  onCreated: (warning?: string) => Promise<void>;
  responses: Record<string, string>;
}) {
  const suggested =
    items.find((item) => responses[item.id] === "fail") ?? items[0];
  const [itemId, setItemId] = useState(suggested?.id ?? "");
  const [title, setTitle] = useState(suggested?.prompt ?? "");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("medium");
  const [assignedTo, setAssignedTo] = useState("");
  const [images, setImages] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      const { issueId } = await createAuditIssue(auditId, {
        assignedTo: assignedTo || null,
        description,
        itemId,
        priority,
        title,
      });
      const failedUploads = (
        await uploadIssueImagesSequentially(issueId, images)
      ).length;
      await onCreated(
        failedUploads > 0
          ? `${failedUploads} image${failedUploads === 1 ? "" : "s"} could not be attached. The issue was created.`
          : undefined,
      );
    } catch (cause) {
      setError(messageFrom(cause));
      setBusy(false);
    }
  }

  return (
    <div className="auditIssueForm">
      {error && <div className="errorBanner">{error}</div>}
      <IssueTextFields
        description={description}
        itemId={itemId}
        items={items}
        onDescriptionChange={setDescription}
        onItemChange={(nextId) => {
          setItemId(nextId);
          setTitle(items.find((item) => item.id === nextId)?.prompt ?? "");
        }}
        onTitleChange={setTitle}
        responses={responses}
        title={title}
      />
      <IssueImagePicker
        files={images}
        onChange={setImages}
        onError={setError}
      />
      <IssueAssignmentFields
        assignedTo={assignedTo}
        members={members}
        onAssignedToChange={setAssignedTo}
        onPriorityChange={setPriority}
        priority={priority}
      />
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

function IssueTextFields({
  description,
  itemId,
  items,
  onDescriptionChange,
  onItemChange,
  onTitleChange,
  responses,
  title,
}: {
  description: string;
  itemId: string;
  items: AuditTemplateItem[];
  onDescriptionChange: (description: string) => void;
  onItemChange: (itemId: string) => void;
  onTitleChange: (title: string) => void;
  responses: Record<string, string>;
  title: string;
}) {
  return (
    <>
      <label className="field">
        <span>Checklist item</span>
        <select
          onChange={(event) => onItemChange(event.target.value)}
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
          onChange={(event) => onTitleChange(event.target.value)}
          value={title}
        />
      </label>
      <label className="field auditIssueDescription">
        <span>Issue description</span>
        <textarea
          maxLength={2000}
          onChange={(event) => onDescriptionChange(event.target.value)}
          placeholder="Describe the problem, evidence, and expected follow-up."
          rows={3}
          value={description}
        />
      </label>
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
    <>
      <label className="field auditIssueImagesField">
        <span>Images</span>
        <input
          accept={acceptedImageTypes.join(",")}
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
        <small>Up to 10 JPEG, PNG, GIF, or WebP images; 10 MB each.</small>
      </label>
      <SelectedIssueImages
        files={files}
        onRemove={(file) =>
          onChange(files.filter((candidate) => candidate !== file))
        }
      />
    </>
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
    <>
      <label className="field">
        <span>Priority</span>
        <select
          onChange={(event) => onPriorityChange(event.target.value)}
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
      </label>
    </>
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
  if (!issues.length) return <p className="auditNoIssues">No issues raised.</p>;
  return (
    <div className="auditIssueList">
      {issues.map((issue) => (
        <IssueCard
          issue={issue}
          key={issue.id}
          members={members}
          onChange={onChange}
          onError={onError}
        />
      ))}
    </div>
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
    <article>
      <span className={`auditPriority ${issue.priority}`}>
        {issue.priority}
      </span>
      <div>
        <h3>{issue.title}</h3>
        {issue.description && <p>{issue.description}</p>}
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
    </article>
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
    <div className="auditIssueActions">
      <label>
        <span>Assignee</span>
        <select
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
      <button
        disabled={busy}
        onClick={() =>
          void onUpdate({
            status: issue.status === "open" ? "resolved" : "open",
          })
        }
        type="button"
      >
        {issue.status === "open" ? "Resolve" : "Reopen"}
      </button>
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
    <div className="auditIssueImages">
      {issue.images.length > 0 && (
        <div className="auditIssueImageGrid">
          {issue.images.map((image) => (
            <div key={image.id}>
              <a
                href={auditIssueImageUrl(issue.id, image.id)}
                rel="noreferrer"
                target="_blank"
              >
                <img
                  alt={image.filename}
                  decoding="async"
                  loading="lazy"
                  src={auditIssueImageUrl(issue.id, image.id, "thumbnail")}
                />
              </a>
              <button
                aria-label={`Remove ${image.filename}`}
                disabled={busy}
                onClick={() => void onRemove(image.id)}
                type="button"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      {issue.images.length < maxIssueImages && (
        <label className="auditIssueAttachButton">
          + Attach images
          <input
            accept={acceptedImageTypes.join(",")}
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
    <div className="auditSelectedImages">
      {files.map((file) => (
        <div key={`${file.name}-${file.size}-${file.lastModified}`}>
          <span title={file.name}>{file.name}</span>
          <button onClick={() => onRemove(file)} type="button">
            Remove
          </button>
        </div>
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
  const validated = validateImageFiles(
    selectedFiles,
    maxIssueImages - existingFiles.length,
  );
  return typeof validated === "string"
    ? validated
    : [...existingFiles, ...validated];
}

function titleCase(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not update audit.";
}
