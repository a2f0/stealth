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
  refreshCheckrScreening,
  startCheckrScreening,
  updateEmployeeRequirement,
  uploadEmployeeForm,
} from "./employeeFormsApi";
import {
  canCompleteRequirement,
  reviewRevisionForStatus,
} from "./employeeOnboarding";
import type {
  OrganizationInvitation,
  OrganizationMember,
} from "./organizationSettingsApi";

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

export function EmployeeForms({
  canManage,
  invitations,
  members,
}: {
  canManage: boolean;
  invitations: OrganizationInvitation[];
  members: OrganizationMember[];
}) {
  const [requirements, setRequirements] = useState<EmployeeRequirement[]>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRequirements(await listEmployeeRequirements());
      setError(undefined);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setLoading(false);
    }
  }, []);
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
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      description="Request tax forms, set due dates, and start or track background and credit checks."
      title="Employee forms and checks"
    >
      {error && <Banner tone="danger">{error}</Banner>}
      {notice && <Banner tone="success">{notice}</Banner>}
      {canManage && (
        <RequirementAssignmentForm
          action={action}
          busy={busy}
          invitations={invitations}
          members={members}
        />
      )}
      {!requirements && loading ? (
        <LoadingState label="Loading requirements…" />
      ) : !requirements ? (
        <Button onClick={() => void load()} size="sm" type="button">
          Retry loading requirements
        </Button>
      ) : requirements.length === 0 ? (
        <p className="muted">No requirements assigned yet.</p>
      ) : (
        <ul className="requirementList">
          {requirements.map((requirement) => (
            <RequirementItem
              action={action}
              busy={busy}
              canManage={canManage}
              key={requirement.id}
              requirement={requirement}
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
  invitations,
  members,
}: {
  action: RequirementAction;
  busy: boolean;
  invitations: OrganizationInvitation[];
  members: OrganizationMember[];
}) {
  const [target, setTarget] = useState("");
  const [drafts, setDrafts] = useState<RequirementDraft[]>([]);
  function assign(event: FormEvent) {
    event.preventDefault();
    if (!target || !drafts.length) return;
    const [type, id] = target.split(":");
    if (!id) return;
    void action(async () => {
      await createEmployeeRequirements(
        type === "member" ? { memberId: id } : { invitationId: id },
        drafts,
      );
      setDrafts([]);
    }, "Requirements assigned.");
  }

  return (
    <form className="requirementAssignment" onSubmit={assign}>
      <Field label="Assign to">
        <select
          className="select"
          disabled={busy}
          onChange={(event) => setTarget(event.target.value)}
          value={target}
        >
          <option value="">Choose a person</option>
          {members.map((member) => (
            <option key={member.id} value={`member:${member.id}`}>
              {member.user.name} ({member.user.email})
            </option>
          ))}
          {invitations.map((invitation) => (
            <option key={invitation.id} value={`invitation:${invitation.id}`}>
              {invitation.email} (invited)
            </option>
          ))}
        </select>
      </Field>
      <RequirementDraftEditor
        drafts={drafts}
        disabled={busy}
        onChange={setDrafts}
      />
      <Button
        busy={busy}
        disabled={!target || !drafts.length}
        type="submit"
        variant="primary"
      >
        Assign requirements
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
}: {
  action: RequirementAction;
  busy: boolean;
  canManage: boolean;
  requirement: EmployeeRequirement;
}) {
  const [reviewedRevision, setReviewedRevision] = useState<number | null>(null);
  return (
    <li className="requirementItem">
      <div className="requirementItemHeader">
        <div>
          <strong>{requirement.title}</strong>
          {canManage && (
            <span className="rowMeta">
              {" "}
              · {requirement.targetName ?? requirement.targetEmail}
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
        <p className="rowMeta">Checkr result: {requirement.checkrResult}</p>
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
  if (requirement.checkrStarted) {
    return (
      <>
        <span className="rowMeta">
          Checkr:{" "}
          {requirement.checkrInvitationStatus?.replaceAll("_", " ") ??
            "pending"}
        </span>
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

function statusTone(status: EmployeeRequirementStatus) {
  if (status === "complete") return "success";
  if (status === "pending") return "warning";
  return "info";
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
