import { confirmDialog } from "@tearleads/ui/react";
import { useCallback, useEffect, useState } from "react";
import { authClient } from "./authClient";
import {
  getOrganizationPeople,
  type OrganizationMember,
  type OrganizationPeopleData,
  updateMemberTwoFactorRequirement,
} from "./organizationSettingsApi";
import {
  type OrganizationInvitationRole,
  organizationRoleValue,
  type WorkspaceOrganization,
} from "./organizationState";

type OrganizationPeopleState = ReturnType<typeof useOrganizationPeopleData>;

/** The organization's members and invitations, with action state. */
export function useOrganizationPeopleData(organizationId: string) {
  const [data, setData] = useState<OrganizationPeopleData>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const load = useCallback(async () => {
    if (!organizationId) return;
    setBusy(true);
    setError(undefined);
    try {
      setData(await getOrganizationPeople());
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }, [organizationId]);
  useEffect(() => void load(), [load]);
  const startAction = () => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
  };
  return {
    busy,
    data,
    error,
    load,
    notice,
    setBusy,
    setError,
    setNotice,
    startAction,
  };
}

export function organizationPeopleActions(
  state: OrganizationPeopleState,
  organization: WorkspaceOrganization,
  onAccessChanged: () => Promise<void>,
) {
  async function cancelInvitation(invitationId: string) {
    state.startAction();
    try {
      const result = await authClient.organization.cancelInvitation({
        invitationId,
      });
      if (result.error) {
        throw new Error(
          result.error.message ?? "Could not revoke this invitation.",
        );
      }
      state.setNotice("Invitation revoked.");
      await state.load();
    } catch (cause) {
      state.setError(messageFrom(cause));
    } finally {
      state.setBusy(false);
    }
  }

  async function updateMemberRole(
    member: OrganizationMember,
    role: OrganizationInvitationRole,
  ) {
    if (organizationRoleValue(member.role) === role) return;
    state.startAction();
    try {
      const result = await authClient.organization.updateMemberRole({
        memberId: member.id,
        organizationId: organization.id,
        role,
      });
      if (result.error) {
        throw new Error(
          result.error.message ?? "Could not update this member’s role.",
        );
      }
      state.setNotice(`${member.user.name} is now an organization ${role}.`);
      await Promise.all([state.load(), onAccessChanged()]);
    } catch (cause) {
      state.setError(messageFrom(cause));
    } finally {
      state.setBusy(false);
    }
  }

  async function updateTwoFactorRequirement(
    member: OrganizationMember,
    required: boolean,
  ) {
    if (member.twoFactorRequired === required) return;
    state.startAction();
    try {
      await updateMemberTwoFactorRequirement(member.id, required);
      state.setNotice(
        required
          ? `${member.user.name} must use two-factor authentication for this organization.`
          : `${member.user.name} is no longer required to use two-factor authentication for this organization.`,
      );
      await Promise.all([state.load(), onAccessChanged()]);
    } catch (cause) {
      state.setError(messageFrom(cause));
    } finally {
      state.setBusy(false);
    }
  }

  return {
    cancelInvitation,
    updateMemberRole,
    updateTwoFactorRequirement,
  };
}

/** Removes a member after confirmation; resolves whether they were removed. */
export async function removeOrganizationMember(
  member: OrganizationMember,
  organization: WorkspaceOrganization,
  state: OrganizationPeopleState,
  onAccessChanged: () => Promise<void>,
) {
  if (!(await confirmMemberRemoval(member, organization))) return false;
  state.startAction();
  try {
    const result = await authClient.organization.removeMember({
      memberIdOrEmail: member.id,
      organizationId: organization.id,
    });
    if (result.error) {
      throw new Error(
        result.error.message ?? "Could not remove this organization member.",
      );
    }
    state.setNotice(`${member.user.name} was removed from the organization.`);
    await Promise.all([state.load(), onAccessChanged()]);
    return true;
  } catch (cause) {
    state.setError(messageFrom(cause));
    return false;
  } finally {
    state.setBusy(false);
  }
}

export function formatRole(role: string) {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function messageFrom(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "Could not update organization people.";
}

function confirmMemberRemoval(
  member: OrganizationMember,
  organization: WorkspaceOrganization,
) {
  return confirmDialog({
    confirmLabel: "Remove member",
    title: `Remove ${member.user.name} from ${organization.name}?`,
    tone: "danger",
  });
}
