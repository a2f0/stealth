import { UpgradeRequiredError } from "./BillingLink";
import type {
  EmployeeRequirementKind,
  EmployeeRequirementStatus,
  RequirementDraft,
} from "./employeeFormsApi";

export function canCompleteRequirement(
  kind: EmployeeRequirementKind,
  documentRevision: number,
  downloadedRevision: number | null,
) {
  return kind !== "form" || downloadedRevision === documentRevision;
}

export function reviewRevisionForStatus(
  kind: EmployeeRequirementKind,
  documentRevision: number,
  downloadedRevision: number | null,
  status: EmployeeRequirementStatus,
) {
  return kind === "form" && status === "complete"
    ? (downloadedRevision ?? -1)
    : documentRevision;
}

export async function inviteWithRequirements<TRole extends string>({
  assign,
  invite,
  onInvited,
  onSent,
  requirements,
  role,
}: {
  assign: (
    invitationId: string,
    requirements: RequirementDraft[],
  ) => Promise<unknown>;
  invite: () => Promise<{
    data?: { id: string; role: TRole } | null;
    error?: { code?: string | undefined; message?: string } | null;
  }>;
  onInvited: () => void;
  onSent: () => Promise<void>;
  requirements: RequirementDraft[];
  role: TRole;
}) {
  const result = await invite();
  if (result.error?.code === "INVITATION_LIMIT_REACHED") {
    throw new UpgradeRequiredError(
      "The Free plan includes one user. Upgrade to Pro to invite more people.",
    );
  }
  if (result.error) {
    throw new Error(result.error.message ?? "Could not send this invitation.");
  }
  onInvited();
  try {
    if (requirements.length) {
      const invitationId = result.data?.id;
      if (!invitationId) throw new Error("Invitation ID unavailable.");
      await assign(invitationId, requirements);
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Unknown error.";
    throw new Error(
      `Invitation sent, but requirements could not be assigned: ${message}`,
    );
  } finally {
    await onSent();
  }
  return result.data?.role ?? role;
}
