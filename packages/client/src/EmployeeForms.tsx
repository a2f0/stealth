import {
  Badge,
  Banner,
  Button,
  Card,
  Field,
  LoadingState,
} from "@tearleads/ui/react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
  createEmployeeRequirements,
  deleteEmployeeRequirement,
  downloadEmployeeForm,
  type EmployeeRequirement,
  type EmployeeRequirementKind,
  type EmployeeRequirementStatus,
  listEmployeeRequirements,
  type RequirementDraft,
  reconcileCheckrScreening,
  refreshCheckrScreening,
  startCheckrScreening,
  updateEmployeeRequirement,
  uploadEmployeeForm,
} from "./employeeFormsApi";
import {
  canCompleteRequirement,
  reviewRevisionForStatus,
} from "./employeeOnboarding";

const options: Array<{ kind: EmployeeRequirementKind; title: string }> = [
  { kind: "form", title: "W-4" },
  { kind: "form", title: "W-9" },
  { kind: "form", title: "I-9" },
  { kind: "form", title: "W-2" },
  { kind: "form", title: "1099" },
  { kind: "form", title: "Other form" },
  { kind: "background_check", title: "Background check" },
  { kind: "credit_check", title: "Credit check" },
];

export function RequirementDraftEditor({
  drafts,
  disabled,
  onChange,
}: {
  drafts: RequirementDraft[];
  disabled: boolean;
  onChange: (drafts: RequirementDraft[]) => void;
}) {
  const [optionIndex, setOptionIndex] = useState(0);
  const [dueDate, setDueDate] = useState("");
  const [customTitle, setCustomTitle] = useState("");
  const selected = options[optionIndex] ?? { kind: "form", title: "W-4" };
  function add() {
    const title =
      selected.title === "Other form" ? customTitle.trim() : selected.title;
    if (!title || !dueDate || drafts.length >= 20) return;
    onChange([
      ...drafts,
      { id: crypto.randomUUID(), kind: selected.kind, title, dueDate },
    ]);
    setCustomTitle("");
  }
  return (
    <div className="requirementEditor">
      <div className="requirementEditorFields">
        <Field label="Requirement">
          <select
            className="select"
            disabled={disabled}
            onChange={(event) => setOptionIndex(Number(event.target.value))}
            value={optionIndex}
          >
            {options.map((option, index) => (
              <option key={`${option.kind}-${option.title}`} value={index}>
                {option.title}
              </option>
            ))}
          </select>
        </Field>
        {selected.title === "Other form" && (
          <Field label="Form name">
            <input
              className="input"
              disabled={disabled}
              maxLength={100}
              onChange={(event) => setCustomTitle(event.target.value)}
              value={customTitle}
            />
          </Field>
        )}
        <Field label="Due date">
          <input
            className="input"
            disabled={disabled}
            onChange={(event) => setDueDate(event.target.value)}
            type="date"
            value={dueDate}
          />
        </Field>
        <Button
          disabled={
            disabled ||
            !dueDate ||
            (selected.title === "Other form" && !customTitle.trim()) ||
            drafts.length >= 20
          }
          onClick={add}
          size="sm"
          type="button"
        >
          Add
        </Button>
      </div>
      {drafts.length > 0 && (
        <ul className="requirementDrafts">
          {drafts.map((draft, index) => (
            <li key={draft.id}>
              <span>
                {draft.title} · Due {formatDate(draft.dueDate)}
              </span>
              <Button
                aria-label={`Remove ${draft.title}`}
                disabled={disabled}
                onClick={() => onChange(drafts.filter((_, at) => at !== index))}
                size="sm"
                type="button"
                variant="ghost"
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Requests either belong to one current member, or have no member page: they
 * target a pending invitation, or a member who has since left.
 */
export type RequirementScope =
  | { kind: "member"; memberId: string }
  | { kind: "unattached"; memberIds: string[] };

export function inRequirementScope(
  scope: RequirementScope,
  requirement: EmployeeRequirement,
) {
  if (scope.kind === "member") return requirement.memberId === scope.memberId;
  return (
    !requirement.memberId || !scope.memberIds.includes(requirement.memberId)
  );
}

/**
 * Requested forms and checks in one scope. On a member's page, managers also
 * request new ones; requests without a member page keep every other control.
 */
export function EmployeeForms({
  canManage,
  scope,
}: {
  canManage: boolean;
  scope: RequirementScope;
}) {
  // Compared by value, so a new scope object for the same people is no change.
  const scopeKey = JSON.stringify(scope);
  const [requirements, setRequirements] = useState<EmployeeRequirement[]>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const current = JSON.parse(scopeKey) as RequirementScope;
      const all = await listEmployeeRequirements();
      setRequirements(all.filter((item) => inRequirementScope(current, item)));
      setError(undefined);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setLoading(false);
    }
  }, [scopeKey]);
  useEffect(() => {
    setRequirements(undefined);
    void load();
  }, [load]);

  async function action(work: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await work();
      await load();
      setNotice(success);
    } catch (cause) {
      const message = messageFrom(cause);
      setRequirements(undefined);
      await load();
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      description={scopeDescription(scope, canManage)}
      title={
        scope.kind === "member"
          ? "Forms and checks"
          : "Invitees and former members"
      }
    >
      {error && <Banner tone="danger">{error}</Banner>}
      {notice && <Banner tone="success">{notice}</Banner>}
      {canManage && scope.kind === "member" && (
        <RequirementAssignmentForm
          action={action}
          busy={busy}
          memberId={scope.memberId}
        />
      )}
      {!requirements && loading ? (
        <LoadingState label="Loading requirements…" />
      ) : !requirements ? (
        <Button onClick={() => void load()} size="sm" type="button">
          Retry loading requirements
        </Button>
      ) : requirements.length === 0 ? (
        <p className="muted">No forms or checks have been requested.</p>
      ) : (
        <ul className="requirementList">
          {requirements.map((requirement) => (
            <RequirementItem
              action={action}
              busy={busy}
              canManage={canManage}
              key={requirement.id}
              requirement={requirement}
              showTarget={scope.kind === "unattached"}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function RequirementAssignmentForm({
  action,
  busy,
  memberId,
}: {
  action: RequirementAction;
  busy: boolean;
  memberId: string;
}) {
  const [drafts, setDrafts] = useState<RequirementDraft[]>([]);
  function assign(event: FormEvent) {
    event.preventDefault();
    if (!drafts.length) return;
    void action(async () => {
      await createEmployeeRequirements({ memberId }, drafts);
      setDrafts([]);
    }, "Requests sent.");
  }

  return (
    <form className="requirementAssignment" onSubmit={assign}>
      <RequirementDraftEditor
        drafts={drafts}
        disabled={busy}
        onChange={setDrafts}
      />
      <Button
        busy={busy}
        disabled={!drafts.length}
        type="submit"
        variant="primary"
      >
        Send requests
      </Button>
    </form>
  );
}

type RequirementAction = (
  work: () => Promise<unknown>,
  success: string,
) => Promise<void>;

function RequirementItem({
  action,
  busy,
  canManage,
  requirement,
  showTarget,
}: {
  action: RequirementAction;
  busy: boolean;
  canManage: boolean;
  requirement: EmployeeRequirement;
  /** Name the person when the list is not already one person's page. */
  showTarget: boolean;
}) {
  const [reviewedRevision, setReviewedRevision] = useState<number | null>(null);
  return (
    <li className="requirementItem">
      <div className="requirementItemHeader">
        <div>
          <strong>{requirement.title}</strong>
          {showTarget && (
            <span className="rowMeta">
              {" "}
              · {requirement.targetName ?? requirement.targetEmail}
              {requirement.invitationId ? " (invited)" : ""}
            </span>
          )}
          <span className="rowMeta">
            {" "}
            · Due {formatDate(requirement.dueDate)}
          </span>
        </div>
        <Badge tone={statusTone(requirement.status)}>
          {formatStatus(requirement.status)}
        </Badge>
      </div>
      {canManage && requirement.checkrResult && (
        <CheckrResult
          completedAt={requirement.completedAt}
          result={requirement.checkrResult}
        />
      )}
      <div className="requirementActions">
        <RequirementDocumentControl
          action={action}
          busy={busy}
          onDownloaded={setReviewedRevision}
          requirement={requirement}
        />
        {canManage && (
          <>
            {requirement.kind !== "form" &&
              (requirement.checkrAvailable ||
                requirement.checkrStarted ||
                requirement.checkrPendingStart) && (
                <CheckrControl
                  action={action}
                  busy={busy}
                  requirement={requirement}
                />
              )}
            {(requirement.kind === "form" ||
              (!requirement.checkrAvailable &&
                !requirement.checkrStarted &&
                !requirement.checkrPendingStart) ||
              ["expired", "canceled", "deleted", "partially_canceled"].includes(
                requirement.checkrInvitationStatus ?? "",
              )) && (
              <RequirementStatusControl
                action={action}
                busy={busy}
                requirement={requirement}
                reviewedRevision={reviewedRevision}
              />
            )}
            <input
              aria-label={`Due date for ${requirement.title}`}
              className="input inputSm"
              disabled={busy}
              onChange={(event) =>
                void action(
                  () =>
                    updateEmployeeRequirement(requirement.id, {
                      dueDate: event.target.value,
                    }),
                  "Due date updated.",
                )
              }
              type="date"
              value={requirement.dueDate}
            />
            {!requirement.checkrStarted && !requirement.checkrPendingStart && (
              <Button
                disabled={busy}
                onClick={() =>
                  void action(
                    () => deleteEmployeeRequirement(requirement.id),
                    "Requirement removed.",
                  )
                }
                size="sm"
                variant="danger"
              >
                Remove
              </Button>
            )}
          </>
        )}
      </div>
    </li>
  );
}

function CheckrControl({
  action,
  busy,
  requirement,
}: {
  action: RequirementAction;
  busy: boolean;
  requirement: EmployeeRequirement;
}) {
  const [state, setState] = useState("");
  const [city, setCity] = useState("");
  const [invitationId, setInvitationId] = useState("");
  if (requirement.checkrStarted) {
    // Once the report has a result, a completed invitation adds nothing.
    const settled =
      requirement.checkrResult !== null &&
      requirement.checkrInvitationStatus === "completed";
    return (
      <>
        {!settled && (
          <span className="rowMeta">
            Checkr:{" "}
            {requirement.checkrInvitationStatus?.replaceAll("_", " ") ??
              "pending"}
          </span>
        )}
        <Button
          disabled={busy}
          onClick={() =>
            void action(
              () => refreshCheckrScreening(requirement.id),
              "Checkr status refreshed.",
            )
          }
          size="sm"
        >
          Refresh check
        </Button>
      </>
    );
  }
  return (
    <div className="checkrStart">
      {requirement.checkrPendingStart && (
        <div className="checkrReconcile">
          <input
            aria-label={`Checkr invitation ID for ${requirement.title}`}
            className="input inputSm"
            disabled={busy}
            onChange={(event) => setInvitationId(event.target.value.trim())}
            placeholder="Checkr invitation ID"
            value={invitationId}
          />
          <Button
            disabled={busy || !invitationId}
            onClick={() =>
              void action(
                () => reconcileCheckrScreening(requirement.id, invitationId),
                "Checkr invitation linked.",
              )
            }
            size="sm"
          >
            Link invitation
          </Button>
        </div>
      )}
      {(requirement.checkrInvitationStatus ||
        requirement.checkrPendingStart) && (
        <span className="rowMeta">
          Checkr:{" "}
          {requirement.checkrInvitationStatus?.replaceAll("_", " ") ??
            "retry needed"}
        </span>
      )}
      <input
        aria-label={`Work state for ${requirement.title}`}
        autoCapitalize="characters"
        className="input inputSm"
        disabled={busy}
        maxLength={2}
        onChange={(event) => setState(event.target.value.toUpperCase())}
        placeholder="State"
        value={state}
      />
      <input
        aria-label={`Work city for ${requirement.title}`}
        className="input inputSm"
        disabled={busy}
        maxLength={100}
        onChange={(event) => setCity(event.target.value)}
        placeholder="City (optional)"
        value={city}
      />
      <Button
        disabled={busy || !/^[A-Z]{2}$/.test(state)}
        onClick={() =>
          void action(
            () => startCheckrScreening(requirement.id, state, city),
            "Checkr invitation sent to the person.",
          )
        }
        size="sm"
      >
        {requirement.checkrInvitationStatus || requirement.checkrPendingStart
          ? "Restart Checkr check"
          : "Start Checkr check"}
      </Button>
    </div>
  );
}

function CheckrResult({
  completedAt,
  result,
}: {
  completedAt: string | null;
  result: string;
}) {
  return (
    <div className="checkrResult">
      <Badge tone={checkrResultTone(result)}>
        Checkr result: {formatCheckrResult(result)}
      </Badge>
      {completedAt && (
        <span className="rowMeta">
          Completed {formatTimestamp(completedAt)}
        </span>
      )}
      {result === "consider" && (
        <p className="rowMeta">
          The report found records to review. Review it in Checkr before making
          a decision.
        </p>
      )}
    </div>
  );
}

function RequirementDocumentControl({
  action,
  busy,
  onDownloaded,
  requirement,
}: {
  action: RequirementAction;
  busy: boolean;
  onDownloaded: (revision: number) => void;
  requirement: EmployeeRequirement;
}) {
  return (
    <>
      {requirement.kind === "form" && requirement.memberId && (
        <label className="requirementUpload">
          <span>
            {requirement.hasDocument ? "Replace file" : "Upload file"}
          </span>
          <input
            accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                void action(
                  () => uploadEmployeeForm(requirement.id, file),
                  "Form submitted.",
                );
              }
              event.target.value = "";
            }}
            type="file"
          />
        </label>
      )}
      {requirement.hasDocument && (
        <Button
          disabled={busy}
          onClick={() =>
            void action(async () => {
              const revision = await downloadEmployeeForm(
                requirement.id,
                requirement.documentFilename ?? "form",
              );
              onDownloaded(revision);
            }, "Download started.")
          }
          size="sm"
          variant="ghost"
        >
          Download {requirement.documentFilename}
        </Button>
      )}
    </>
  );
}

function RequirementStatusControl({
  action,
  busy,
  requirement,
  reviewedRevision,
}: {
  action: RequirementAction;
  busy: boolean;
  requirement: EmployeeRequirement;
  reviewedRevision: number | null;
}) {
  if (requirement.kind === "form" && !requirement.hasDocument) return null;
  return (
    <select
      aria-label={`Status for ${requirement.title}`}
      className="select inputSm"
      disabled={busy}
      onChange={(event) =>
        void action(
          () =>
            updateEmployeeRequirement(requirement.id, {
              documentRevision: reviewRevisionForStatus(
                requirement.kind,
                requirement.documentRevision,
                reviewedRevision,
                event.target.value as EmployeeRequirementStatus,
              ),
              status: event.target.value as EmployeeRequirementStatus,
            }),
          "Status updated.",
        )
      }
      value={requirement.status}
    >
      <option value="pending">Pending</option>
      {requirement.kind === "form" ? (
        <option value="submitted">Submitted</option>
      ) : (
        <option value="in_progress">In progress</option>
      )}
      <option
        disabled={
          !canCompleteRequirement(
            requirement.kind,
            requirement.documentRevision,
            reviewedRevision,
          )
        }
        value="complete"
      >
        Complete
      </option>
    </select>
  );
}

function scopeDescription(scope: RequirementScope, canManage: boolean) {
  if (scope.kind === "unattached") {
    return "Requests for people who haven’t accepted their invitation yet, or who have left the organization.";
  }
  return canManage
    ? "Request tax forms, set due dates, and start or track background and credit checks."
    : "Forms and checks your organization has requested from you.";
}

function statusTone(status: EmployeeRequirementStatus) {
  if (status === "complete") return "success";
  if (status === "pending") return "warning";
  return "info";
}

function checkrResultTone(result: string) {
  if (result === "clear") return "success";
  if (result === "consider") return "warning";
  return "neutral";
}

function formatCheckrResult(result: string) {
  return result
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(value),
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function formatStatus(status: EmployeeRequirementStatus) {
  return status
    .replace("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function messageFrom(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "Could not update requirements.";
}
