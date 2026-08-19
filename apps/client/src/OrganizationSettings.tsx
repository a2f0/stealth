import { type FormEvent, useCallback, useEffect, useState } from "react";
import { authClient } from "./authClient";
import {
  canLeaveOrganization,
  canManageOrganization,
} from "./organizationState";

interface OrganizationRecord {
  createdAt: Date;
  id: string;
  name: string;
  slug: string;
}

interface OrganizationMemberRecord {
  id: string;
  role: string;
  user: { email: string; name: string };
}

interface OrganizationInvitationRecord {
  email: string;
  expiresAt: Date;
  id: string;
  status: string;
}

interface OrganizationSettingsData {
  fallbackOrganization?: OrganizationRecord | undefined;
  invitations: OrganizationInvitationRecord[];
  memberRole: string;
  members: OrganizationMemberRecord[];
  organization: OrganizationRecord;
}

export function OrganizationSettings({
  onLeft,
}: {
  onLeft: () => Promise<void>;
}) {
  const { data: session } = authClient.useSession();
  const state = useOrganizationSettingsData(
    session?.session.activeOrganizationId,
  );
  const organization = state.data?.organization;
  const canManage = canManageOrganization(state.data?.memberRole);

  async function save(event: FormEvent) {
    event.preventDefault();
    const nextName = state.name.trim();
    if (!organization || !nextName) return;
    state.startAction();
    try {
      const result = await authClient.organization.update({
        data: { name: nextName },
        organizationId: organization.id,
      });
      if (result.error) {
        throw new Error(
          result.error.message ?? "Could not update your organization.",
        );
      }
      state.setNotice("Organization name updated.");
      await state.load();
    } catch (cause) {
      state.setError(messageFrom(cause));
    } finally {
      state.setBusy(false);
    }
  }

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

  return (
    <OrganizationSettingsView
      busy={state.busy}
      canManage={canManage}
      data={state.data}
      error={state.error}
      name={state.name}
      notice={state.notice}
      onCancel={cancelInvitation}
      onLeave={() => leaveOrganization(state, onLeft)}
      onName={state.setName}
      onReload={state.load}
      onSave={save}
    />
  );
}

async function leaveOrganization(
  state: ReturnType<typeof useOrganizationSettingsData>,
  onLeft: () => Promise<void>,
) {
  const data = state.data;
  const organization = data?.organization;
  const canLeave = canLeaveOrganization(
    data?.memberRole,
    data?.members.map(({ role }) => role) ?? [],
    Boolean(data?.fallbackOrganization),
  );
  if (!organization || !canLeave) return;
  if (
    !window.confirm(
      `Leave ${organization.name}? You’ll lose access to its files and workspace data.`,
    )
  ) {
    return;
  }
  state.startAction();
  try {
    const result = await authClient.organization.leave({
      organizationId: organization.id,
    });
    if (result.error) {
      throw new Error(
        result.error.message ?? "Could not leave this organization.",
      );
    }
    await onLeft();
  } catch (cause) {
    state.setError(messageFrom(cause));
  } finally {
    state.setBusy(false);
  }
}

function useOrganizationSettingsData(activeOrganizationId?: string | null) {
  const [data, setData] = useState<OrganizationSettingsData>();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const load = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const nextData = await fetchOrganizationSettings(activeOrganizationId);
      setData(nextData);
      setName(nextData.organization.name);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }, [activeOrganizationId]);
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
    name,
    notice,
    setBusy,
    setError,
    setName,
    setNotice,
    startAction,
  };
}

async function fetchOrganizationSettings(activeOrganizationId?: string | null) {
  const organizationResult = await authClient.organization.list();
  if (organizationResult.error) {
    throw new Error(
      organizationResult.error.message ?? "Could not load your organization.",
    );
  }
  const organization =
    organizationResult.data?.find(({ id }) => id === activeOrganizationId) ??
    organizationResult.data?.[0];
  if (!organization) throw new Error("Your active organization was not found.");
  const [roleResult, membersResult, invitationsResult] = await Promise.all([
    authClient.organization.getActiveMemberRole({
      query: { organizationId: organization.id },
    }),
    authClient.organization.listMembers({
      query: { limit: 100, organizationId: organization.id },
    }),
    authClient.organization.listInvitations({
      query: { organizationId: organization.id },
    }),
  ]);
  const requestError =
    roleResult.error ?? membersResult.error ?? invitationsResult.error;
  if (requestError) {
    throw new Error(
      requestError.message ?? "Could not load organization members.",
    );
  }
  return {
    fallbackOrganization: organizationResult.data?.find(
      ({ id }) => id !== organization.id,
    ),
    invitations: (
      (invitationsResult.data ?? []) as OrganizationInvitationRecord[]
    ).filter(({ status }) => status === "pending"),
    memberRole: roleResult.data?.role ?? "member",
    members: (membersResult.data?.members ?? []) as OrganizationMemberRecord[],
    organization,
  };
}

function OrganizationSettingsView({
  busy,
  canManage,
  data,
  error,
  name,
  notice,
  onCancel,
  onLeave,
  onName,
  onReload,
  onSave,
}: {
  busy: boolean;
  canManage: boolean;
  data: OrganizationSettingsData | undefined;
  error: string | undefined;
  name: string;
  notice: string | undefined;
  onCancel: (invitationId: string) => Promise<void>;
  onLeave: () => Promise<void>;
  onName: (name: string) => void;
  onReload: () => Promise<void>;
  onSave: (event: FormEvent) => Promise<void>;
}) {
  return (
    <>
      <header className="topbar">
        <div>
          <p className="eyebrow">Workspace settings</p>
          <h1>Organization</h1>
        </div>
      </header>
      <section className="content">
        {error && <div className="errorBanner">{error}</div>}
        {notice && (
          <div aria-live="polite" className="successBanner pageBanner">
            {notice}
          </div>
        )}
        {data ? (
          <div className="organizationSettingsGrid">
            <OrganizationDetailsCard
              busy={busy}
              canManage={canManage}
              data={data}
              name={name}
              onName={onName}
              onSave={onSave}
            />
            {canManage && (
              <InviteMemberForm
                onSent={onReload}
                organizationId={data.organization.id}
              />
            )}
            <OrganizationMembers members={data.members} />
            {canManage && data.invitations.length > 0 && (
              <PendingInvitations
                busy={busy}
                invitations={data.invitations}
                onCancel={onCancel}
              />
            )}
            <LeaveOrganizationCard
              busy={busy}
              canLeave={canLeaveOrganization(
                data.memberRole,
                data.members.map(({ role }) => role),
                Boolean(data.fallbackOrganization),
              )}
              data={data}
              onLeave={onLeave}
            />
          </div>
        ) : !error ? (
          <div className="emptyState compactEmptyState">
            <div className="emptyGlyph">◇</div>
            <h3>{busy ? "Loading organization…" : "No organization found."}</h3>
          </div>
        ) : null}
      </section>
    </>
  );
}

function LeaveOrganizationCard({
  busy,
  canLeave,
  data,
  onLeave,
}: {
  busy: boolean;
  canLeave: boolean;
  data: OrganizationSettingsData;
  onLeave: () => Promise<void>;
}) {
  const restriction = !data.fallbackOrganization
    ? "Join another organization before leaving this one."
    : !canLeave
      ? "Assign another owner before leaving this organization."
      : "Your account and your other organizations will remain available.";
  return (
    <section className="settingsCard leaveOrganizationCard">
      <div>
        <h2>Leave organization</h2>
        <p>{restriction}</p>
      </div>
      <button
        className="dangerButton settingsSubmit"
        disabled={busy || !canLeave}
        onClick={() => void onLeave()}
        type="button"
      >
        {busy ? "Leaving…" : "Leave organization"}
      </button>
    </section>
  );
}

function OrganizationDetailsCard({
  busy,
  canManage,
  data,
  name,
  onName,
  onSave,
}: {
  busy: boolean;
  canManage: boolean;
  data: OrganizationSettingsData;
  name: string;
  onName: (name: string) => void;
  onSave: (event: FormEvent) => Promise<void>;
}) {
  return (
    <form className="settingsCard" onSubmit={(event) => void onSave(event)}>
      <div>
        <h2>Organization details</h2>
        <p>Active workspace · your role is {data.memberRole}.</p>
      </div>
      <label className="field">
        <span>Organization name</span>
        <input
          autoComplete="organization"
          disabled={busy || !canManage}
          maxLength={100}
          name="organization"
          onChange={(event) => onName(event.target.value)}
          required
          type="text"
          value={name}
        />
      </label>
      {canManage && (
        <button
          className="primaryButton settingsSubmit"
          disabled={
            busy || !name.trim() || name.trim() === data.organization.name
          }
          type="submit"
        >
          {busy ? "Saving…" : "Save changes"}
        </button>
      )}
    </form>
  );
}

function InviteMemberForm({
  onSent,
  organizationId,
}: {
  onSent: () => Promise<void>;
  organizationId: string;
}) {
  const [email, setEmail] = useState("");
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
        resend: true,
        role: "member",
      });
      if (result.error) {
        throw new Error(
          result.error.message ?? "Could not send this invitation.",
        );
      }
      setEmail("");
      setNotice(`Invitation sent to ${invitedEmail}.`);
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
  members,
}: {
  members: OrganizationMemberRecord[];
}) {
  return (
    <section className="settingsCard organizationPeople">
      <div>
        <h2>Members</h2>
        <p>{members.length} people have access to this organization.</p>
      </div>
      <div className="organizationPeopleList">
        {members.map((member) => (
          <div key={member.id}>
            <span>
              <strong>{member.user.name}</strong>
              <small>{member.user.email}</small>
            </span>
            <b>{member.role}</b>
          </div>
        ))}
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
  invitations: OrganizationInvitationRecord[];
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
              <small>Expires {formatDate(invitation.expiresAt)}</small>
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

function formatDate(value: Date) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(value),
  );
}

function messageFrom(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "Could not update your organization.";
}
