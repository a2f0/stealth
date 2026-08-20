import { type FormEvent, useCallback, useEffect, useState } from "react";
import { authClient } from "./authClient";
import {
  getOrganizationPeople,
  type OrganizationInvitation,
  type OrganizationMember,
  type OrganizationPeopleData,
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
  const canManage = canManageOrganization(state.data?.memberRole);

  async function cancelInvitation(invitationId: string) {
    state.startAction();
    try {
      const result = await authClient.organization.cancelInvitation({
        invitationId,
      });
      if (result.error) {
        throw new Error(
          result.error.message ?? "Could not cancel this invitation.",
        );
      }
      state.setNotice("Invitation canceled.");
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

  return (
    <>
      {state.error && <div className="errorBanner">{state.error}</div>}
      {state.notice && (
        <div aria-live="polite" className="successBanner pageBanner">
          {state.notice}
        </div>
      )}
      {state.data ? (
        <div className="organizationSettingsGrid">
          {canManage && (
            <InviteMemberForm
              key={organization.id}
              memberRole={state.data.memberRole}
              onSent={state.load}
              organizationId={organization.id}
            />
          )}
          <OrganizationMembers
            busy={state.busy}
            managerRole={state.data.memberRole}
            members={state.data.members}
            onRoleChange={updateMemberRole}
          />
          {canManage && state.data.invitations.length > 0 && (
            <PendingInvitations
              busy={state.busy}
              invitations={state.data.invitations}
              onCancel={cancelInvitation}
            />
          )}
        </div>
      ) : !state.error ? (
        <div className="emptyState compactEmptyState">
          <div className="emptyGlyph">◇</div>
          <h3>Loading people…</h3>
        </div>
      ) : (
        <button
          className="primaryButton"
          onClick={() => void state.load()}
          type="button"
        >
          Try again
        </button>
      )}
    </>
  );
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

  async function invite(event: FormEvent) {
    event.preventDefault();
    const invitedEmail = email.trim().toLowerCase();
    if (!invitedEmail) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await authClient.organization.inviteMember({
        email: invitedEmail,
        organizationId,
        role,
      });
      if (result.error) {
        throw new Error(
          result.error.message ?? "Could not send this invitation.",
        );
      }
      const assignedRole = result.data?.role ?? role;
      setEmail("");
      setNotice(
        `Invitation sent to ${invitedEmail} with the ${assignedRole} role.`,
      );
      await onSent();
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="settingsCard" onSubmit={(event) => void invite(event)}>
      <div>
        <h2>Invite a member</h2>
        <p>They’ll receive a single-use invitation that expires in 48 hours.</p>
      </div>
      <label className="field">
        <span>Email address</span>
        <input
          autoCapitalize="none"
          autoComplete="email"
          disabled={busy}
          inputMode="email"
          name="invite-email"
          onChange={(event) => setEmail(event.target.value)}
          required
          spellCheck={false}
          type="email"
          value={email}
        />
      </label>
      <label className="field">
        <span>Organization role</span>
        <select
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
        <small>{roleDescription(role)}</small>
      </label>
      {error && <div className="errorBanner compactBanner">{error}</div>}
      {notice && <div className="successBanner compactBanner">{notice}</div>}
      <button
        className="primaryButton settingsSubmit"
        disabled={busy || !email.trim()}
        type="submit"
      >
        {busy ? "Sending…" : "Send invitation"}
      </button>
    </form>
  );
}

function OrganizationMembers({
  busy,
  managerRole,
  members,
  onRoleChange,
}: {
  busy: boolean;
  managerRole: string;
  members: OrganizationMember[];
  onRoleChange: (
    member: OrganizationMember,
    role: OrganizationInvitationRole,
  ) => Promise<void>;
}) {
  const memberRoles = members.map(({ role }) => role);
  return (
    <section className="settingsCard organizationPeople">
      <div>
        <h2>Members</h2>
        <p>{members.length} people have access to this organization.</p>
      </div>
      <div className="organizationPeopleList">
        {members.map((member) => {
          const roles = editableOrganizationRoles(
            managerRole,
            member.role,
            memberRoles,
          );
          const role = organizationRoleValue(member.role);
          return (
            <div key={member.id}>
              <span>
                <strong>{member.user.name}</strong>
                <small>{member.user.email}</small>
              </span>
              {roles.length > 0 ? (
                <select
                  aria-label={`Role for ${member.user.name}`}
                  className="memberRoleSelect"
                  disabled={busy || roles.length === 1}
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
                <b>{role}</b>
              )}
            </div>
          );
        })}
      </div>
    </section>
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
    <section className="settingsCard organizationPeople">
      <div>
        <h2>Pending invitations</h2>
        <p>Invitations that have not been accepted yet.</p>
      </div>
      <div className="organizationPeopleList">
        {invitations.map((invitation) => (
          <div key={invitation.id}>
            <span>
              <strong>{invitation.email}</strong>
              <small>
                {formatRole(invitation.role)} · Expires{" "}
                {formatDate(invitation.expiresAt)}
              </small>
            </span>
            <button
              disabled={busy}
              onClick={() => void onCancel(invitation.id)}
              type="button"
            >
              Cancel
            </button>
          </div>
        ))}
      </div>
    </section>
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
