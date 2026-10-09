import {
  Avatar,
  Badge,
  Banner,
  Button,
  ButtonLink,
  Card,
  EmptyState,
  LoadingState,
} from "@tearleads/ui/react";
import { EmployeeForms } from "./EmployeeForms";
import {
  MemberRoleControl,
  MemberTwoFactorControl,
  TwoFactorStatus,
} from "./memberControls";
import {
  organizationPeopleActions,
  removeOrganizationMember,
  useOrganizationPeopleData,
} from "./organizationPeopleState";
import type { OrganizationMember } from "./organizationSettingsApi";
import {
  canManageOrganization,
  editableOrganizationRoles,
  type OrganizationInvitationRole,
  organizationPeoplePath,
  type WorkspaceOrganization,
} from "./organizationState";
import { handleNavigation } from "./workspacePaths";

/**
 * One member: who they are, their role and two-factor requirement, and the
 * forms and checks requested from them. Managers see and change everything;
 * a member sees their own requests here.
 */
export function OrganizationMemberDetail({
  memberId,
  onAccessChanged,
  onNavigate,
  organization,
}: {
  memberId: string;
  onAccessChanged: () => Promise<void>;
  onNavigate: (pathname: string) => void;
  organization: WorkspaceOrganization;
}) {
  const state = useOrganizationPeopleData(organization.id);
  const actions = organizationPeopleActions(
    state,
    organization,
    onAccessChanged,
  );
  const data = state.data;
  const member = data?.members.find(({ id }) => id === memberId);
  const back = <BackToPeople onNavigate={onNavigate} />;

  if (!data) {
    return (
      <>
        {back}
        {state.error ? (
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
          <LoadingState label="Loading member…" />
        )}
      </>
    );
  }
  if (!member) {
    return (
      <>
        {back}
        <EmptyState icon="organization" title="This member isn’t here">
          They may have left or been removed from the organization.
        </EmptyState>
      </>
    );
  }

  const canManage = canManageOrganization(data.memberRole);
  const isSelf = data.currentMemberId === member.id;
  return (
    <>
      {back}
      {state.error && <Banner tone="danger">{state.error}</Banner>}
      {state.notice && <Banner tone="success">{state.notice}</Banner>}
      <MemberProfile
        busy={state.busy}
        canManage={canManage}
        isSelf={isSelf}
        member={member}
        onRemove={async () => {
          if (
            await removeOrganizationMember(
              member,
              organization,
              state,
              onAccessChanged,
            )
          ) {
            onNavigate(organizationPeoplePath());
          }
        }}
        onRoleChange={actions.updateMemberRole}
        onTwoFactorRequiredChange={actions.updateTwoFactorRequirement}
        roles={editableOrganizationRoles(
          data.memberRole,
          member.role,
          data.members.map(({ role }) => role),
        )}
      />
      {(canManage || isSelf) && (
        <EmployeeForms
          canManage={canManage}
          key={member.id}
          memberId={member.id}
        />
      )}
    </>
  );
}

function BackToPeople({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  const path = organizationPeoplePath();
  return (
    <div>
      <ButtonLink
        href={path}
        icon="arrowLeft"
        onClick={(event) => handleNavigation(event, path, onNavigate)}
        size="sm"
        variant="ghost"
      >
        All people
      </ButtonLink>
    </div>
  );
}

function MemberProfile({
  busy,
  canManage,
  isSelf,
  member,
  onRemove,
  onRoleChange,
  onTwoFactorRequiredChange,
  roles,
}: {
  busy: boolean;
  canManage: boolean;
  isSelf: boolean;
  member: OrganizationMember;
  onRemove: () => Promise<void>;
  onRoleChange: (
    member: OrganizationMember,
    role: OrganizationInvitationRole,
  ) => Promise<void>;
  onTwoFactorRequiredChange: (
    member: OrganizationMember,
    required: boolean,
  ) => Promise<void>;
  roles: OrganizationInvitationRole[];
}) {
  return (
    <Card
      actions={
        roles.length > 1 && (
          <Button
            disabled={busy}
            onClick={() => void onRemove()}
            size="sm"
            variant="danger"
          >
            Remove from organization
          </Button>
        )
      }
      description={member.user.email}
      title={
        <span className="memberProfileTitle">
          <Avatar name={member.user.name} size="lg" />
          <span className="truncate">{member.user.name}</span>
          {isSelf && <Badge>You</Badge>}
        </span>
      }
    >
      <dl className="keyValue memberProfileDetails">
        <dt>Role</dt>
        <dd>
          <MemberRoleControl
            busy={busy}
            member={member}
            onChange={onRoleChange}
            roles={roles}
          />
        </dd>
        <dt>Joined</dt>
        <dd>{formatDate(member.joinedAt)}</dd>
        {canManage && (
          <>
            <dt>Two-factor</dt>
            <dd className="memberProfileTwoFactor">
              <TwoFactorStatus member={member} />
              <MemberTwoFactorControl
                busy={busy}
                canManage
                member={member}
                onChange={onTwoFactorRequiredChange}
              />
            </dd>
          </>
        )}
      </dl>
    </Card>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(value),
  );
}
