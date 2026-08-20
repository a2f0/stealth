import { type FormEvent, type MouseEvent, useEffect, useState } from "react";
import { authClient } from "./authClient";
import { OrganizationAccessSettings } from "./OrganizationGroups";
import { OrganizationPeople } from "./OrganizationPeople";
import {
  canLeaveOrganizationWithOwnerCount,
  canManageOrganization,
  organizationSettingsPage,
  type WorkspaceOrganization,
} from "./organizationState";

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
    <>
      <header className="topbar organizationSettingsHeader">
        <div>
          <p className="eyebrow">Workspace settings</p>
          <h1>Organization</h1>
        </div>
        <OrganizationSettingsNavigation
          canManage={canManage}
          onNavigate={onNavigate}
          page={page}
        />
      </header>
      <section className="content organizationSettingsContent">
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
      </section>
    </>
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
  if (!organization) return <SettingsLoading label="Loading organization…" />;
  if (page === "people") {
    return (
      <OrganizationPeople
        organization={organization}
        onAccessChanged={onAccessChanged}
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
  return (
    <OrganizationGeneral
      accessError={accessError}
      memberRole={memberRole}
      onWorkspaceChanged={onWorkspaceChanged}
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
    <nav aria-label="Organization settings" className="settingsSubnav">
      {items.map((item) => (
        <a
          aria-current={page === item.page ? "page" : undefined}
          className={page === item.page ? "active" : undefined}
          href={item.path}
          key={item.path}
          onClick={(event) => handleNavigation(event, item.path, onNavigate)}
        >
          {item.label}
        </a>
      ))}
    </nav>
  );
}

function OrganizationGeneral({
  accessError,
  memberRole,
  onWorkspaceChanged,
  organization,
  organizations,
  ownerCount,
}: {
  accessError: string | undefined;
  memberRole: string | undefined;
  onWorkspaceChanged: () => Promise<void>;
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
  const actions = useOrganizationGeneralActions(
    organization,
    canLeave,
    onWorkspaceChanged,
  );

  return (
    <>
      {accessError && <div className="errorBanner">{accessError}</div>}
      {actions.error && <div className="errorBanner">{actions.error}</div>}
      {actions.notice && (
        <div aria-live="polite" className="successBanner pageBanner">
          {actions.notice}
        </div>
      )}
      <div className="organizationSettingsGrid">
        <OrganizationDetailsCard
          busy={actions.action !== undefined}
          loadError={accessError}
          memberRole={memberRole}
          name={actions.name}
          onName={actions.setName}
          onSave={actions.save}
          organization={organization}
        />
        <LeaveOrganizationCard
          action={actions.action}
          canLeave={canLeave}
          hasAnotherOrganization={hasAnotherOrganization}
          memberRole={memberRole}
          onLeave={actions.leave}
        />
      </div>
    </>
  );
}

function useOrganizationGeneralActions(
  organization: WorkspaceOrganization,
  canLeave: boolean,
  onWorkspaceChanged: () => Promise<void>,
) {
  const [name, setName] = useState(organization.name);
  const [action, setAction] = useState<"leave" | "save">();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  useEffect(() => setName(organization.name), [organization.name]);
  const start = (nextAction: "leave" | "save") => {
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
    if (
      !window.confirm(
        `Leave ${organization.name}? You’ll lose access to its files and workspace data.`,
      )
    ) {
      return;
    }
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
  return { action, error, leave, name, notice, save, setName };
}

function OrganizationDetailsCard({
  busy,
  loadError,
  memberRole,
  name,
  onName,
  onSave,
  organization,
}: {
  busy: boolean;
  loadError: string | undefined;
  memberRole: string | undefined;
  name: string;
  onName: (name: string) => void;
  onSave: (event: FormEvent) => Promise<void>;
  organization: WorkspaceOrganization;
}) {
  const canManage = canManageOrganization(memberRole);
  return (
    <form className="settingsCard" onSubmit={(event) => void onSave(event)}>
      <div>
        <h2>Organization details</h2>
        <p>
          {memberRole
            ? `Active workspace · your role is ${formatRole(memberRole)}.`
            : loadError
              ? "Your organization role could not be loaded."
              : "Loading your organization role…"}
        </p>
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
          disabled={busy || !name.trim() || name.trim() === organization.name}
          type="submit"
        >
          {busy ? "Saving…" : "Save changes"}
        </button>
      )}
    </form>
  );
}

function LeaveOrganizationCard({
  action,
  canLeave,
  hasAnotherOrganization,
  memberRole,
  onLeave,
}: {
  action: "leave" | "save" | undefined;
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
    <section className="settingsCard leaveOrganizationCard">
      <div>
        <h2>Leave organization</h2>
        <p>{restriction}</p>
      </div>
      <button
        className="dangerButton settingsSubmit"
        disabled={action !== undefined || !canLeave}
        onClick={() => void onLeave()}
        type="button"
      >
        {action === "leave" ? "Leaving…" : "Leave organization"}
      </button>
    </section>
  );
}

function SettingsLoading({ label }: { label: string }) {
  return (
    <div className="emptyState compactEmptyState">
      <div className="emptyGlyph">◇</div>
      <h3>{label}</h3>
    </div>
  );
}

function SettingsAccessDenied({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  return (
    <div className="emptyState compactEmptyState">
      <div className="emptyGlyph">◇</div>
      <h3>Organization manager access is required.</h3>
      <button onClick={() => onNavigate("/organization")} type="button">
        Return to general settings
      </button>
    </div>
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
