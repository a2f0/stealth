import {
  Avatar,
  Badge,
  Banner,
  Button,
  ButtonLink,
  Card,
  cx,
  Field,
  Icon,
  LoadingState,
} from "@tearleads/ui/react";
import {
  type FormEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useRef,
  useState,
} from "react";
import { authClient } from "./authClient";
import { ErrorBanner, type ErrorNotice, errorNotice } from "./BillingLink";
import { RequirementDraftEditor } from "./EmployeeForms";
import {
  createEmployeeRequirements,
  type EmployeeRequirement,
  listEmployeeRequirements,
  type RequirementDraft,
} from "./employeeFormsApi";
import { inviteWithRequirements } from "./employeeOnboarding";
import {
  MemberRoleControl,
  MemberTwoFactorControl,
  TwoFactorStatus,
} from "./memberControls";
import {
  formatRole,
  organizationPeopleActions,
  removeOrganizationMember,
  useOrganizationPeopleData,
} from "./organizationPeopleState";
import type {
  OrganizationInvitation,
  OrganizationMember,
  OrganizationPeopleData,
} from "./organizationSettingsApi";
import {
  assignableOrganizationRoles,
  canManageOrganization,
  editableOrganizationRoles,
  type OrganizationInvitationRole,
  organizationPeoplePath,
  type WorkspaceOrganization,
} from "./organizationState";
import { useFocusWhenFolded } from "./useFocusWhenFolded";
import { handleNavigation } from "./workspacePaths";

/**
 * The first invitation is sent from an open form. Once anyone else has joined
 * or been invited, the form folds behind an "Invite member" action so the
 * member list leads the page.
 */
export function OrganizationPeople({
  onAccessChanged,
  onNavigate,
  organization,
}: {
  onAccessChanged: () => Promise<void>;
  onNavigate: (pathname: string) => void;
  organization: WorkspaceOrganization;
}) {
  const state = useOrganizationPeopleData(organization.id);
  const [inviting, setInviting] = useState(false);
  const requirements = useRequirementSummary(state.data);
  const canManage = canManageOrganization(state.data?.memberRole);
  const hasOthers = Boolean(
    state.data &&
      (state.data.members.length > 1 || state.data.invitations.length > 0),
  );
  const formOpen = canManage && (inviting || !hasOthers);
  const inviteButton = useFocusWhenFolded(formOpen);

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
    <PeopleBody
      canManage={canManage}
      data={state.data}
      formOpen={formOpen}
      inviteAction={
        canManage && hasOthers && !inviting ? (
          <Button
            icon="userAdd"
            onClick={() => setInviting(true)}
            ref={inviteButton}
            size="sm"
            variant="primary"
          >
            Invite member
          </Button>
        ) : null
      }
      onAccessChanged={onAccessChanged}
      onInviteClosed={hasOthers ? () => setInviting(false) : undefined}
      onNavigate={onNavigate}
      organization={organization}
      requirements={requirements}
      state={state}
    />
  );
}

function PeopleBody({
  canManage,
  data,
  formOpen,
  inviteAction,
  onAccessChanged,
  onInviteClosed,
  onNavigate,
  organization,
  requirements,
  state,
}: {
  canManage: boolean;
  data: OrganizationPeopleData;
  formOpen: boolean;
  inviteAction: ReactNode;
  onAccessChanged: () => Promise<void>;
  onInviteClosed: (() => void) | undefined;
  onNavigate: (pathname: string) => void;
  organization: WorkspaceOrganization;
  requirements: EmployeeRequirement[];
  state: ReturnType<typeof useOrganizationPeopleData>;
}) {
  const actions = organizationPeopleActions(
    state,
    organization,
    onAccessChanged,
  );
  const openCount = (matches: (requirement: EmployeeRequirement) => boolean) =>
    requirements.filter(
      (requirement) =>
        requirement.status !== "complete" && matches(requirement),
    ).length;
  return (
    <>
      {state.error && <Banner tone="danger">{state.error}</Banner>}
      {state.notice && <Banner tone="success">{state.notice}</Banner>}
      {!canManage && data.currentMemberId && (
        <OwnRequestsNotice
          count={openCount(() => true)}
          memberId={data.currentMemberId}
          onNavigate={onNavigate}
        />
      )}
      {formOpen && (
        <InviteMemberForm
          key={organization.id}
          memberRole={data.memberRole}
          onCancel={onInviteClosed}
          onNavigate={onNavigate}
          onSent={state.load}
          onSuccess={(message) => {
            state.setNotice(message);
            onInviteClosed?.();
          }}
          organizationId={organization.id}
        />
      )}
      <OrganizationMembers
        action={inviteAction}
        busy={state.busy}
        managerRole={data.memberRole}
        members={data.members}
        onNavigate={onNavigate}
        onRemove={async (member) => {
          await removeOrganizationMember(
            member,
            organization,
            state,
            onAccessChanged,
          );
        }}
        onRoleChange={actions.updateMemberRole}
        onTwoFactorRequiredChange={actions.updateTwoFactorRequirement}
        openRequests={(member) =>
          openCount((requirement) => requirement.memberId === member.id)
        }
      />
      {canManage && data.invitations.length > 0 && (
        <PendingInvitations
          busy={state.busy}
          invitations={data.invitations}
          onCancel={actions.cancelInvitation}
          requested={(invitation) =>
            requirements.filter(
              (requirement) => requirement.invitationId === invitation.id,
            )
          }
        />
      )}
    </>
  );
}

/**
 * Requested forms and checks, for the list's counts. Each member's page loads
 * and reports them in full, so a failure here only leaves the counts out.
 */
function useRequirementSummary(data: OrganizationPeopleData | undefined) {
  const [requirements, setRequirements] = useState<EmployeeRequirement[]>([]);
  const people = data
    ? [...data.members, ...data.invitations].map(({ id }) => id).join(",")
    : "";
  useEffect(() => {
    if (!people) return;
    let active = true;
    listEmployeeRequirements()
      .then((next) => {
        if (active) setRequirements(next);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [people]);
  return requirements;
}

function OwnRequestsNotice({
  count,
  memberId,
  onNavigate,
}: {
  count: number;
  memberId: string;
  onNavigate: (pathname: string) => void;
}) {
  if (count === 0) return null;
  const path = organizationPeoplePath(memberId);
  return (
    <Banner
      actions={
        <ButtonLink
          href={path}
          onClick={(event) => handleNavigation(event, path, onNavigate)}
          size="sm"
        >
          View your forms
        </ButtonLink>
      }
      tone="info"
    >
      {count === 1
        ? "Your organization has requested a form or check from you."
        : `Your organization has requested ${count} forms or checks from you.`}
    </Banner>
  );
}

function InviteMemberForm({
  memberRole,
  onCancel,
  onNavigate,
  onSent,
  onSuccess,
  organizationId,
}: {
  memberRole: string;
  /** Present when the form was opened on demand and can fold away again. */
  onCancel: (() => void) | undefined;
  onNavigate: (pathname: string) => void;
  onSent: () => Promise<void>;
  onSuccess: (message: string) => void;
  organizationId: string;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrganizationInvitationRole>("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorNotice>();
  const [requirements, setRequirements] = useState<RequirementDraft[]>([]);
  const emailField = useRef<HTMLInputElement>(null);
  const openedOnDemand = Boolean(onCancel);
  // The header button that opened the form is gone; move focus into the form.
  useEffect(() => {
    if (openedOnDemand) emailField.current?.focus();
  }, [openedOnDemand]);

  async function invite(event: FormEvent) {
    event.preventDefault();
    const invitedEmail = email.trim().toLowerCase();
    if (!invitedEmail) return;
    setBusy(true);
    setError(undefined);
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
      onSuccess(
        `Invitation sent to ${invitedEmail} with the ${assignedRole} role.`,
      );
    } catch (cause) {
      setError(errorNotice(cause, "Could not send this invitation."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      description="They’ll receive a single-use invitation that expires in 48 hours."
      footer={
        <>
          {onCancel && (
            <Button disabled={busy} onClick={onCancel} variant="ghost">
              Cancel
            </Button>
          )}
          <Button
            busy={busy}
            disabled={!email.trim()}
            icon="mail"
            type="submit"
            variant="primary"
          >
            {busy ? "Sending…" : "Send invitation"}
          </Button>
        </>
      }
      onSubmit={(event) => void invite(event)}
      title="Invite a member"
    >
      <InviteFields
        busy={busy}
        email={email}
        emailField={emailField}
        memberRole={memberRole}
        onEmail={setEmail}
        onRole={setRole}
        role={role}
      />
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
      <ErrorBanner error={error} onNavigate={onNavigate} />
    </Card>
  );
}

function InviteFields({
  busy,
  email,
  emailField,
  memberRole,
  onEmail,
  onRole,
  role,
}: {
  busy: boolean;
  email: string;
  emailField: Ref<HTMLInputElement>;
  memberRole: string;
  onEmail: (email: string) => void;
  onRole: (role: OrganizationInvitationRole) => void;
  role: OrganizationInvitationRole;
}) {
  return (
    <div className="inviteFields">
      <Field label="Email address">
        <input
          autoCapitalize="none"
          autoComplete="email"
          className="input"
          disabled={busy}
          inputMode="email"
          name="invite-email"
          onChange={(event) => onEmail(event.target.value)}
          placeholder="name@company.com"
          ref={emailField}
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
            onRole(event.target.value as OrganizationInvitationRole)
          }
          value={role}
        >
          {assignableOrganizationRoles(memberRole).map((assignableRole) => (
            <option key={assignableRole} value={assignableRole}>
              {formatRole(assignableRole)}
            </option>
          ))}
        </select>
      </Field>
    </div>
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
              code: result.error.code,
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
  onNavigate: (pathname: string) => void;
  onRoleChange: (
    member: OrganizationMember,
    role: OrganizationInvitationRole,
  ) => Promise<void>;
  onRemove: (member: OrganizationMember) => Promise<void>;
  onTwoFactorRequiredChange: (
    member: OrganizationMember,
    required: boolean,
  ) => Promise<void>;
  openRequests: (member: OrganizationMember) => number;
}

function OrganizationMembers({
  action,
  managerRole,
  members,
  ...controls
}: MemberControlsProps & {
  action: ReactNode;
  managerRole: string;
  members: OrganizationMember[];
}) {
  const memberRoles = members.map(({ role }) => role);
  const canManage = canManageOrganization(managerRole);
  return (
    <Card
      actions={action}
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
  onNavigate,
  onRemove,
  onRoleChange,
  onTwoFactorRequiredChange,
  openRequests,
  roles,
}: MemberControlsProps & {
  canManage: boolean;
  member: OrganizationMember;
  roles: OrganizationInvitationRole[];
}) {
  const path = organizationPeoplePath(member.id);
  const open = openRequests(member);
  return (
    <li className="row memberRow">
      <a
        className="memberIdentity memberLink"
        href={path}
        onClick={(event) => handleNavigation(event, path, onNavigate)}
      >
        <Avatar name={member.user.name} />
        <div className="rowMain">
          <span className="memberName">
            <span className="rowTitle truncate">{member.user.name}</span>
            {canManage && <TwoFactorStatus member={member} />}
            {open > 0 && (
              <Badge tone="info">
                {open} open {open === 1 ? "request" : "requests"}
              </Badge>
            )}
          </span>
          <span className="rowMeta truncate">{member.user.email}</span>
        </div>
      </a>
      <div className="memberTwoFactor">
        <MemberTwoFactorControl
          busy={busy}
          canManage={canManage}
          member={member}
          onChange={onTwoFactorRequiredChange}
        />
      </div>
      <div className="memberRole">
        <MemberRoleControl
          busy={busy}
          member={member}
          onChange={onRoleChange}
          roles={roles}
        />
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

function PendingInvitations({
  busy,
  invitations,
  onCancel,
  requested,
}: {
  busy: boolean;
  invitations: OrganizationInvitation[];
  onCancel: (invitationId: string) => Promise<void>;
  requested: (invitation: OrganizationInvitation) => EmployeeRequirement[];
}) {
  return (
    <Card
      description="Invitations that have not been accepted yet. Requested forms move to the member’s page when they join."
      flush
      title="Pending invitations"
    >
      <ul className="rowList">
        {invitations.map((invitation) => {
          const forms = requested(invitation);
          return (
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
                  {forms.length > 0 && (
                    <span className="rowMeta">
                      Requested:{" "}
                      {forms.map((requirement) => requirement.title).join(", ")}
                    </span>
                  )}
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
          );
        })}
      </ul>
    </Card>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(value),
  );
}

function roleDescription(role: OrganizationInvitationRole) {
  if (role === "owner") return "Full access, including ownership controls.";
  if (role === "admin") return "Can manage people, groups, and settings.";
  return "Standard access to the organization workspace.";
}
