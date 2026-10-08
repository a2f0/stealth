import {
  Banner,
  Button,
  Card,
  confirmDialog,
  EmptyState,
  Field,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
} from "@tearleads/ui/react";
import { type FormEvent, type MouseEvent, useEffect, useState } from "react";
import { authClient } from "./authClient";
import { OrganizationBilling } from "./OrganizationBilling";
import { OrganizationAccessSettings } from "./OrganizationGroups";
import { OrganizationPeople } from "./OrganizationPeople";
import { deleteCurrentOrganization } from "./organizationSettingsApi";
import {
  canDeleteOrganization,
  canLeaveOrganizationWithOwnerCount,
  canManageOrganization,
  organizationSettingsPage,
  type WorkspaceOrganization,
} from "./organizationState";

type OrganizationGeneralAction = "delete" | "leave" | "save";

export function OrganizationSettings({
  accessError,
  activeOrganizationId,
  memberRole,
  onAccessChanged,
  onNavigate,
  onWorkspaceChanged,
  organizations,
  ownerCount,
  pathname,
}: {
  accessError: string | undefined;
  activeOrganizationId: string | undefined;
  memberRole: string | undefined;
  onAccessChanged: () => Promise<void>;
  onNavigate: (pathname: string) => void;
  onWorkspaceChanged: () => Promise<void>;
  organizations: WorkspaceOrganization[];
  ownerCount: number;
  pathname: string;
}) {
  const organization = organizations.find(
    ({ id }) => id === activeOrganizationId,
  );
  const page = organizationSettingsPage(pathname);
  const canManage = canManageOrganization(memberRole);
  return (
    <Page>
      <PageHeader
        eyebrow="Organization"
        tabs={
          <OrganizationSettingsNavigation
            canManage={canManage}
            onNavigate={onNavigate}
            page={page}
          />
        }
        tabsLabel="Organization settings"
        title={organization?.name ?? "Organization settings"}
      />
      <PageBody
        className={
          page === "general" || page === "billing"
            ? "organizationNarrowBody"
            : undefined
        }
      >
        <OrganizationSettingsPageContent
          accessError={accessError}
          canManage={canManage}
          memberRole={memberRole}
          onAccessChanged={onAccessChanged}
          onNavigate={onNavigate}
          onWorkspaceChanged={onWorkspaceChanged}
          organization={organization}
          organizations={organizations}
          ownerCount={ownerCount}
          page={page}
        />
      </PageBody>
    </Page>
  );
}

function OrganizationSettingsPageContent({
  accessError,
  canManage,
  memberRole,
  onAccessChanged,
  onNavigate,
  onWorkspaceChanged,
  organization,
  organizations,
  ownerCount,
  page,
}: {
  accessError: string | undefined;
  canManage: boolean;
  memberRole: string | undefined;
  onAccessChanged: () => Promise<void>;
  onNavigate: (pathname: string) => void;
  onWorkspaceChanged: () => Promise<void>;
  organization: WorkspaceOrganization | undefined;
  organizations: WorkspaceOrganization[];
  ownerCount: number;
  page: ReturnType<typeof organizationSettingsPage>;
}) {
  if (!organization) return <LoadingState label="Loading organization…" />;
  if (page === "people") {
    return (
      <OrganizationPeople
        organization={organization}
        onAccessChanged={onAccessChanged}
        onNavigate={onNavigate}
      />
    );
  }
  if (page === "access") {
    if (memberRole !== undefined && !canManage) {
      return <SettingsAccessDenied onNavigate={onNavigate} />;
    }
    return (
      <OrganizationAccessSettings
        onAccessChanged={onAccessChanged}
        organizationId={organization.id}
      />
    );
  }
  if (page === "billing") {
    return <OrganizationBilling organizationId={organization.id} />;
  }
  return (
    <OrganizationGeneral
      accessError={accessError}
      memberRole={memberRole}
      onWorkspaceChanged={onWorkspaceChanged}
      onNavigate={onNavigate}
      organization={organization}
      organizations={organizations}
      ownerCount={ownerCount}
    />
  );
}

function OrganizationSettingsNavigation({
  canManage,
  onNavigate,
  page,
}: {
  canManage: boolean;
  onNavigate: (pathname: string) => void;
  page: ReturnType<typeof organizationSettingsPage>;
}) {
  const items = [
    { label: "General", page: "general", path: "/organization" },
    { label: "People", page: "people", path: "/organization/people" },
    { label: "Billing", page: "billing", path: "/organization/billing" },
    ...(canManage
      ? [
          {
            label: "Access",
            page: "access",
            path: "/organization/access",
          },
        ]
      : []),
  ] as const;
  return (
    <>
      {items.map((item) => (
        <a
          aria-current={page === item.page ? "page" : undefined}
          className="tab"
          href={item.path}
          key={item.path}
          onClick={(event) => handleNavigation(event, item.path, onNavigate)}
        >
          {item.label}
        </a>
      ))}
    </>
  );
}

function OrganizationGeneral({
  accessError,
  memberRole,
  onWorkspaceChanged,
  onNavigate,
  organization,
  organizations,
  ownerCount,
}: {
  accessError: string | undefined;
  memberRole: string | undefined;
  onWorkspaceChanged: () => Promise<void>;
  onNavigate: (pathname: string) => void;
  organization: WorkspaceOrganization;
  organizations: WorkspaceOrganization[];
  ownerCount: number;
}) {
  const hasAnotherOrganization = organizations.some(
    ({ id }) => id !== organization.id,
  );
  const canLeave = Boolean(
    memberRole &&
      canLeaveOrganizationWithOwnerCount(
        memberRole,
        ownerCount,
        hasAnotherOrganization,
      ),
  );
  const canDelete = canDeleteOrganization(memberRole);
  const actions = useOrganizationGeneralActions(
    organization,
    canLeave,
    onWorkspaceChanged,
    onNavigate,
  );

  return (
    <>
      {accessError && <Banner tone="danger">{accessError}</Banner>}
      {actions.error && <Banner tone="danger">{actions.error}</Banner>}
      {actions.notice && <Banner tone="success">{actions.notice}</Banner>}
      <OrganizationDetailsCard
        busy={actions.action !== undefined}
        loadError={accessError}
        memberRole={memberRole}
        name={actions.name}
        onName={actions.setName}
        onSave={actions.save}
        organization={organization}
        saving={actions.action === "save"}
      />
      <div className="stack">
        <LeaveOrganizationCard
          action={actions.action}
          canLeave={canLeave}
          hasAnotherOrganization={hasAnotherOrganization}
          memberRole={memberRole}
          onLeave={actions.leave}
        />
        {canDelete && (
          <DeleteOrganizationCard
            action={actions.action}
            onDelete={actions.remove}
            organizationName={organization.name}
          />
        )}
      </div>
    </>
  );
}

function useOrganizationGeneralActions(
  organization: WorkspaceOrganization,
  canLeave: boolean,
  onWorkspaceChanged: () => Promise<void>,
  onNavigate: (pathname: string) => void,
) {
  const [name, setName] = useState(organization.name);
  const [action, setAction] = useState<OrganizationGeneralAction>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  useEffect(() => setName(organization.name), [organization.name]);
  const start = (nextAction: OrganizationGeneralAction) => {
    setAction(nextAction);
    setError(undefined);
    setNotice(undefined);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName || nextName === organization.name) return;
    start("save");
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
      setNotice("Organization name updated.");
      await onWorkspaceChanged();
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setAction(undefined);
    }
  };
  const leave = async () => {
    if (!canLeave) return;
    if (!(await confirmLeave(organization.name))) return;
    start("leave");
    try {
      const result = await authClient.organization.leave({
        organizationId: organization.id,
      });
      if (result.error) {
        throw new Error(
          result.error.message ?? "Could not leave this organization.",
        );
      }
      await onWorkspaceChanged();
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setAction(undefined);
    }
  };
  const remove = async () => {
    if (!(await confirmOrganizationDeletion(organization.name))) return;
    start("delete");
    try {
      await deleteCurrentOrganization();
      await onWorkspaceChanged();
      onNavigate("/");
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setAction(undefined);
    }
  };
  return { action, error, leave, name, notice, remove, save, setName };
}

function OrganizationDetailsCard({
  busy,
  loadError,
  memberRole,
  name,
  onName,
  onSave,
  organization,
  saving,
}: {
  busy: boolean;
  loadError: string | undefined;
  memberRole: string | undefined;
  name: string;
  onName: (name: string) => void;
  onSave: (event: FormEvent) => Promise<void>;
  organization: WorkspaceOrganization;
  saving: boolean;
}) {
  const canManage = canManageOrganization(memberRole);
  return (
    <Card
      description={
        memberRole
          ? `Active workspace · your role is ${formatRole(memberRole)}.`
          : loadError
            ? "Your organization role could not be loaded."
            : "Loading your organization role…"
      }
      footer={
        canManage && (
          <Button
            busy={saving}
            disabled={busy || !name.trim() || name.trim() === organization.name}
            type="submit"
            variant="primary"
          >
            {saving ? "Saving…" : "Save changes"}
          </Button>
        )
      }
      onSubmit={(event) => void onSave(event)}
      title="Organization details"
    >
      <Field label="Organization name">
        <input
          autoComplete="organization"
          className="input"
          disabled={busy || !canManage}
          maxLength={100}
          name="organization"
          onChange={(event) => onName(event.target.value)}
          required
          type="text"
          value={name}
        />
      </Field>
    </Card>
  );
}

function LeaveOrganizationCard({
  action,
  canLeave,
  hasAnotherOrganization,
  memberRole,
  onLeave,
}: {
  action: OrganizationGeneralAction | undefined;
  canLeave: boolean;
  hasAnotherOrganization: boolean;
  memberRole: string | undefined;
  onLeave: () => Promise<void>;
}) {
  const restriction = !memberRole
    ? "Loading membership controls…"
    : !hasAnotherOrganization
      ? "Join another organization before leaving this one."
      : !canLeave
        ? "Assign another owner before leaving this organization."
        : "Your account and your other organizations will remain available.";
  return (
    <Card
      actions={
        <Button
          busy={action === "leave"}
          disabled={action !== undefined || !canLeave}
          icon="signOut"
          onClick={() => void onLeave()}
          variant="danger"
        >
          {action === "leave" ? "Leaving…" : "Leave organization"}
        </Button>
      }
      className="organizationActionCard"
      description={restriction}
      title="Leave organization"
    />
  );
}

function DeleteOrganizationCard({
  action,
  onDelete,
  organizationName,
}: {
  action: OrganizationGeneralAction | undefined;
  onDelete: () => Promise<void>;
  organizationName: string;
}) {
  return (
    <Card
      actions={
        <Button
          busy={action === "delete"}
          disabled={action !== undefined}
          icon="trash"
          onClick={() => void onDelete()}
          variant="danger"
        >
          {action === "delete" ? "Deleting…" : "Delete organization"}
        </Button>
      }
      className="cardDanger organizationActionCard"
      description={`${organizationName} and all of its workspace data will become unavailable immediately. Permanent deletion occurs after 30 days.`}
      title="Delete organization"
    />
  );
}

function SettingsAccessDenied({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  return (
    <EmptyState
      actions={
        <Button icon="arrowLeft" onClick={() => onNavigate("/organization")}>
          Return to general settings
        </Button>
      }
      icon="lock"
      title="Organization manager access is required."
    />
  );
}

function handleNavigation(
  event: MouseEvent<HTMLAnchorElement>,
  pathname: string,
  onNavigate: (pathname: string) => void,
) {
  if (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }
  event.preventDefault();
  onNavigate(pathname);
}

function formatRole(role: string) {
  return role
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.charAt(0).toUpperCase() + value.slice(1))
    .join(", ");
}

function messageFrom(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "Could not update your organization.";
}

function confirmLeave(name: string) {
  return confirmDialog({
    confirmLabel: "Leave organization",
    message: "You’ll lose access to its files and workspace data.",
    title: `Leave ${name}?`,
    tone: "danger",
  });
}

function confirmOrganizationDeletion(name: string) {
  return confirmDialog({
    confirmLabel: "Delete organization",
    message:
      "All of its data will be scheduled for permanent deletion in 30 days.",
    title: `Delete ${name}?`,
    tone: "danger",
    typeToConfirm: name,
  });
}
