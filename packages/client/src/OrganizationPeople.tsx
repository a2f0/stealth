import {
  Avatar,
  Badge,
  Banner,
  Button,
  Card,
  confirmDialog,
  cx,
  Field,
  Icon,
  LoadingState,
} from "@tearleads/ui/react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { authClient } from "./authClient";
import { EmployeeForms, RequirementDraftEditor } from "./EmployeeForms";
import {
  createEmployeeRequirements,
  type RequirementDraft,
} from "./employeeFormsApi";
import { inviteWithRequirements } from "./employeeOnboarding";
import {
  getOrganizationPeople,
  type OrganizationInvitation,
  type OrganizationMember,
  type OrganizationPeopleData,
  updateMemberTwoFactorRequirement,
} from "./organizationSettingsApi";
import {
  assignableOrganizationRoles,
  canManageOrganization,
  editableOrganizationRoles,
  type OrganizationInvitationRole,
  organizationRoleValue,
  type WorkspaceOrganization,
} from "./organizationState";

export function OrganizationPeople({
  onAccessChanged,
  organization,
}: {
  onAccessChanged: () => Promise<void>;
  organization: WorkspaceOrganization;
}) {
  const state = useOrganizationPeopleData(organization.id);
  const [formsVersion, setFormsVersion] = useState(0);
  const canManage = canManageOrganization(state.data?.memberRole);
  const actions = organizationPeopleActions(
    state,
    organization,
    onAccessChanged,
  );

  if (!state.data) {
    return state.error ? (
      <Banner
        actions={
          <Button onClick={() => void state.load()} size="sm">
            Try again
          </Button>
        }
        tone="danger"
      >
        {state.error}
      </Banner>
    ) : (
      <LoadingState label="Loading people…" />
    );
  }

  return (
    <>
      {state.error && <Banner tone="danger">{state.error}</Banner>}
      {state.notice && <Banner tone="success">{state.notice}</Banner>}
      {canManage && (
        <InviteMemberForm
          key={organization.id}
          memberRole={state.data.memberRole}
          onSent={async () => {
            await state.load();
            setFormsVersion((version) => version + 1);
          }}
          organizationId={organization.id}
        />
      )}
      <OrganizationMembers
        busy={state.busy}
        managerRole={state.data.memberRole}
        members={state.data.members}
        onRemove={(member) =>
          removeOrganizationMember(member, organization, state, onAccessChanged)
        }
        onRoleChange={actions.updateMemberRole}
        onTwoFactorRequiredChange={actions.updateTwoFactorRequirement}
      />
      <EmployeeForms
        canManage={canManage}
        invitations={state.data.invitations}
        key={`${organization.id}-${formsVersion}-${state.data.members
          .map((member) => member.id)
          .join(",")}-${state.data.invitations
          .map((invitation) => `${invitation.id}:${invitation.status}`)
          .join(",")}`}
        members={state.data.members}
      />
      {canManage && state.data.invitations.length > 0 && (
        <PendingInvitations
          busy={state.busy}
          invitations={state.data.invitations}
          onCancel={actions.cancelInvitation}
        />
      )}
    </>
  );
}

async function removeOrganizationMember(
  member: OrganizationMember,
  organization: WorkspaceOrganization,
  state: ReturnType<typeof useOrganizationPeopleData>,
  onAccessChanged: () => Promise<void>,
) {
  if (!(await confirmMemberRemoval(member, organization))) return;
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
  } catch (cause) {
    state.setError(messageFrom(cause));
  } finally {
    state.setBusy(false);
  }
}

function useOrganizationPeopleData(organizationId: string) {
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

function organizationPeopleActions(
  state: ReturnType<typeof useOrganizationPeopleData>,
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

function InviteMemberForm({
  memberRole,
  onSent,
  organizationId,
}: {
  memberRole: string;
  onSent: () => Promise<void>;
  organizationId: string;
}) {
  const assignableRoles = assignableOrganizationRoles(memberRole);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrganizationInvitationRole>("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [requirements, setRequirements] = useState<RequirementDraft[]>([]);

  async function invite(event: FormEvent) {
    event.preventDefault();
    const invitedEmail = email.trim().toLowerCase();
    if (!invitedEmail) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const assignedRole = await sendInvitationWithRequirements({
        email: invitedEmail,
        onInvited: () => setEmail(""),
        onSent,
        organizationId,
        requirements,
        role,
      });
      setRequirements([]);
      setNotice(
        `Invitation sent to ${invitedEmail} with the ${assignedRole} role.`,
      );
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      description="They’ll receive a single-use invitation that expires in 48 hours."
      footer={
        <Button
          busy={busy}
          disabled={!email.trim()}
          icon="mail"
          type="submit"
          variant="primary"
        >
          {busy ? "Sending…" : "Send invitation"}
        </Button>
      }
      onSubmit={(event) => void invite(event)}
      title="Invite a member"
    >
      <div className="inviteFields">
        <Field label="Email address">
          <input
            autoCapitalize="none"
            autoComplete="email"
            className="input"
            disabled={busy}
            inputMode="email"
            name="invite-email"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="name@company.com"
            required
            spellCheck={false}
            type="email"
            value={email}
          />
        </Field>
        <Field hint={roleDescription(role)} label="Organization role">
          <select
            className="select"
            disabled={busy}
            name="invite-role"
            onChange={(event) =>
              setRole(event.target.value as OrganizationInvitationRole)
            }
            value={role}
          >
            {assignableRoles.map((assignableRole) => (
              <option key={assignableRole} value={assignableRole}>
                {formatRole(assignableRole)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="inviteRequirements">
        <h3>Onboarding requirements</h3>
        <p className="muted">
          Choose any forms or checks needed from this person and set each due
          date.
        </p>
        <RequirementDraftEditor
          drafts={requirements}
          disabled={busy}
          onChange={setRequirements}
        />
      </div>
      {error && <Banner tone="danger">{error}</Banner>}
      {notice && <Banner tone="success">{notice}</Banner>}
    </Card>
  );
}

async function sendInvitationWithRequirements({
  email,
  onInvited,
  onSent,
  organizationId,
  requirements,
  role,
}: {
  email: string;
  onInvited: () => void;
  onSent: () => Promise<void>;
  organizationId: string;
  requirements: RequirementDraft[];
  role: OrganizationInvitationRole;
}) {
  return inviteWithRequirements({
    assign: (invitationId, drafts) =>
      createEmployeeRequirements({ invitationId }, drafts),
    invite: async () => {
      const result = await authClient.organization.inviteMember({
        email,
        organizationId,
        role,
      });
      return {
        data: result.data
          ? { id: result.data.id, role: result.data.role }
          : null,
        error: result.error
          ? {
              message:
                result.error.message ?? "Could not send this invitation.",
            }
          : null,
      };
    },
    onInvited,
    onSent,
    requirements,
    role,
  });
}

interface MemberControlsProps {
  busy: boolean;
  onRoleChange: (
    member: OrganizationMember,
    role: OrganizationInvitationRole,
  ) => Promise<void>;
  onRemove: (member: OrganizationMember) => Promise<void>;
  onTwoFactorRequiredChange: (
    member: OrganizationMember,
    required: boolean,
  ) => Promise<void>;
}

function OrganizationMembers({
  managerRole,
  members,
  ...controls
}: MemberControlsProps & {
  managerRole: string;
  members: OrganizationMember[];
}) {
  const memberRoles = members.map(({ role }) => role);
  const canManage = canManageOrganization(managerRole);
  return (
    <Card
      description={`${members.length} ${
        members.length === 1 ? "person has" : "people have"
      } access to this organization.`}
      flush
      title="Members"
    >
      <div className="memberListFrame">
        <ul
          className={cx(
            "rowList memberList",
            !canManage && "memberListReadOnly",
          )}
        >
          {members.map((member) => (
            <MemberRow
              {...controls}
              canManage={canManage}
              key={member.id}
              member={member}
              roles={editableOrganizationRoles(
                managerRole,
                member.role,
                memberRoles,
              )}
            />
          ))}
        </ul>
      </div>
    </Card>
  );
}

function MemberRow({
  busy,
  canManage,
  member,
  onRemove,
  onRoleChange,
  onTwoFactorRequiredChange,
  roles,
}: MemberControlsProps & {
  canManage: boolean;
  member: OrganizationMember;
  roles: OrganizationInvitationRole[];
}) {
  const role = organizationRoleValue(member.role);
  return (
    <li className="row memberRow">
      <div className="memberIdentity">
        <Avatar name={member.user.name} />
        <div className="rowMain">
          <span className="memberName">
            <span className="rowTitle truncate">{member.user.name}</span>
            {canManage && <TwoFactorStatus member={member} />}
          </span>
          <span className="rowMeta truncate">{member.user.email}</span>
        </div>
      </div>
      <div className="memberTwoFactor">
        {canManage ? (
          <label className="check">
            <input
              aria-label={`Require two-factor authentication for ${member.user.name}`}
              checked={member.twoFactorRequired}
              disabled={busy}
              onChange={(event) =>
                void onTwoFactorRequiredChange(member, event.target.checked)
              }
              type="checkbox"
            />
            <span>Require 2FA</span>
          </label>
        ) : (
          member.twoFactorRequired && <Badge tone="info">2FA required</Badge>
        )}
      </div>
      <div className="memberRole">
        {roles.length > 1 ? (
          <select
            aria-label={`Role for ${member.user.name}`}
            className="select inputSm memberRoleSelect"
            disabled={busy}
            onChange={(event) =>
              void onRoleChange(
                member,
                event.target.value as OrganizationInvitationRole,
              )
            }
            value={role}
          >
            {roles.map((assignableRole) => (
              <option key={assignableRole} value={assignableRole}>
                {formatRole(assignableRole)}
              </option>
            ))}
          </select>
        ) : (
          <Badge>{formatRole(role)}</Badge>
        )}
      </div>
      <div className="memberActions">
        {roles.length > 1 && (
          <Button
            disabled={busy}
            onClick={() => void onRemove(member)}
            size="sm"
            variant="danger"
          >
            Remove
          </Button>
        )}
      </div>
    </li>
  );
}

function TwoFactorStatus({ member }: { member: OrganizationMember }) {
  if (member.twoFactorEnabled) {
    return <Badge tone="success">2FA enabled</Badge>;
  }
  return (
    <Badge tone={member.twoFactorRequired ? "warning" : "neutral"}>
      2FA not set up
    </Badge>
  );
}

function PendingInvitations({
  busy,
  invitations,
  onCancel,
}: {
  busy: boolean;
  invitations: OrganizationInvitation[];
  onCancel: (invitationId: string) => Promise<void>;
}) {
  return (
    <Card
      description="Invitations that have not been accepted yet."
      flush
      title="Pending invitations"
    >
      <ul className="rowList">
        {invitations.map((invitation) => (
          <li className="row" key={invitation.id}>
            <div className="memberIdentity">
              <span aria-hidden="true" className="invitationMark">
                <Icon name="mail" size={16} />
              </span>
              <div className="rowMain">
                <span className="rowTitle truncate">{invitation.email}</span>
                <span className="rowMeta">
                  {formatRole(invitation.role)} · Expires{" "}
                  {formatDate(invitation.expiresAt)}
                </span>
              </div>
            </div>
            <Button
              disabled={busy}
              onClick={() => void onCancel(invitation.id)}
              size="sm"
              variant="danger"
            >
              Revoke
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(value),
  );
}

function formatRole(role: string) {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function roleDescription(role: OrganizationInvitationRole) {
  if (role === "owner") return "Full access, including ownership controls.";
  if (role === "admin") return "Can manage people, groups, and settings.";
  return "Standard access to the organization workspace.";
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
