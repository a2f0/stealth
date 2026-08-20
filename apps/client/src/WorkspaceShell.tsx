import {
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  useState,
} from "react";
import { AccountControl } from "./AccountControl";
import type { AccountSession } from "./accountSessions";
import type { WorkspaceOrganization } from "./organizationState";
import { SidebarResizeHandle } from "./SidebarResizeHandle";
import { readSidebarWidth } from "./sidebarWidth";

export interface WorkspaceUser {
  email: string;
  emailVerified: boolean;
  name: string;
  role?: string | null | undefined;
}

interface WorkspaceShellProps {
  accountLoadError: string | undefined;
  accounts: AccountSession[];
  activePage:
    | "admin"
    | "audits"
    | "finance"
    | "inbox"
    | "library"
    | "organization";
  activeOrganizationId: string | undefined;
  activeSessionToken: string;
  canAccessFinance: boolean;
  children: ReactNode;
  contentKey: string | undefined;
  onAccountChange: (sessionToken: string) => Promise<void>;
  onAddAccount: () => void;
  onNavigate: (pathname: string) => void;
  onOrganizationChange: (organizationId: string) => Promise<void>;
  onOrganizationCreate: (name: string) => Promise<void>;
  onRefreshAccounts: () => Promise<void>;
  onSignOut: () => Promise<void>;
  organizations: WorkspaceOrganization[];
  user: WorkspaceUser;
}

export function WorkspaceShell({
  accountLoadError,
  accounts,
  activePage,
  activeOrganizationId,
  activeSessionToken,
  canAccessFinance,
  children,
  contentKey,
  onAccountChange,
  onAddAccount,
  onNavigate,
  onOrganizationChange,
  onOrganizationCreate,
  onRefreshAccounts,
  onSignOut,
  organizations,
  user,
}: WorkspaceShellProps) {
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const shellStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
  } as CSSProperties;
  return (
    <div className="shell" style={shellStyle}>
      <aside className="sidebar">
        <a
          aria-label="Stealth home"
          className="brand"
          href="/"
          onClick={(event) => handleNavigation(event, "/", onNavigate)}
        >
          <span className="brandMark">S</span>
          <span>stealth</span>
        </a>
        <OrganizationSwitcher
          activeOrganizationId={activeOrganizationId}
          onOrganizationChange={onOrganizationChange}
          onOrganizationCreate={onOrganizationCreate}
          organizations={organizations}
        />
        <nav aria-label="Workspace">
          <a
            className={activePage === "library" ? "navItem active" : "navItem"}
            href="/"
            onClick={(event) => handleNavigation(event, "/", onNavigate)}
          >
            <span className="navIcon">⌁</span> Library
          </a>
          <a
            className={activePage === "audits" ? "navItem active" : "navItem"}
            href="/audits"
            onClick={(event) => handleNavigation(event, "/audits", onNavigate)}
          >
            <span className="navIcon">✓</span> Audits
          </a>
          {canAccessFinance && (
            <a
              className={
                activePage === "finance" ? "navItem active" : "navItem"
              }
              href="/finance"
              onClick={(event) =>
                handleNavigation(event, "/finance", onNavigate)
              }
            >
              <span className="navIcon">$</span> Finance
            </a>
          )}
          <a
            className={
              activePage === "organization" ? "navItem active" : "navItem"
            }
            href="/organization"
            onClick={(event) =>
              handleNavigation(event, "/organization", onNavigate)
            }
          >
            <span className="navIcon">◇</span> Organization
          </a>
          {hasRole(user.role, "admin") && (
            <>
              <a
                className={
                  activePage === "inbox" ? "navItem active" : "navItem"
                }
                href="/inbox"
                onClick={(event) =>
                  handleNavigation(event, "/inbox", onNavigate)
                }
              >
                <span className="navIcon">✉</span> Inbox
              </a>
              <a
                className={
                  activePage === "admin" ? "navItem active" : "navItem"
                }
                href="/admin"
                onClick={(event) =>
                  handleNavigation(event, "/admin", onNavigate)
                }
              >
                <span className="navIcon">◎</span> Users
              </a>
            </>
          )}
        </nav>
        <div className="sidebarFoot">
          <span className="statusDot" /> Cloudflare connected
        </div>
        <AccountControl
          accounts={accounts}
          activeSessionToken={activeSessionToken}
          loadError={accountLoadError}
          onAddAccount={onAddAccount}
          onRefreshAccounts={onRefreshAccounts}
          onSignOut={onSignOut}
          onSwitchAccount={onAccountChange}
          user={user}
        />
      </aside>

      <SidebarResizeHandle
        onWidthChange={setSidebarWidth}
        width={sidebarWidth}
      />

      <main key={contentKey}>{children}</main>
    </div>
  );
}

function OrganizationSwitcher({
  activeOrganizationId,
  onOrganizationChange,
  onOrganizationCreate,
  organizations,
}: {
  activeOrganizationId: string | undefined;
  onOrganizationChange: (organizationId: string) => Promise<void>;
  onOrganizationCreate: (name: string) => Promise<void>;
  organizations: WorkspaceOrganization[];
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (organizations.length === 0 || !activeOrganizationId) {
    return (
      <div className="organizationSwitcher">
        <span>Organization</span>
        <button
          className="organizationCreateButton"
          disabled={busy}
          onClick={() => void select("create")}
          type="button"
        >
          {busy ? "Creating…" : "Create organization…"}
        </button>
        {error && <small role="alert">{error}</small>}
      </div>
    );
  }

  async function select(organizationId: string) {
    if (organizationId === "create") {
      const name = window.prompt("Organization name")?.trim();
      if (!name) return;
      setBusy(true);
      setError(undefined);
      try {
        await onOrganizationCreate(name);
      } catch (cause) {
        setError(messageFrom(cause));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (organizationId === activeOrganizationId) return;
    setBusy(true);
    setError(undefined);
    try {
      await onOrganizationChange(organizationId);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="organizationSwitcher">
      <label>
        <span>Organization</span>
        <select
          aria-label="Active organization"
          disabled={busy}
          onChange={(event) => void select(event.target.value)}
          value={activeOrganizationId}
        >
          {organizations.map((organization) => (
            <option key={organization.id} value={organization.id}>
              {organization.name}
            </option>
          ))}
          <option value="create">Create organization…</option>
        </select>
      </label>
      {error && <small role="alert">{error}</small>}
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

export function hasRole(
  roles: string | null | undefined,
  expectedRole: string,
) {
  return (
    roles?.split(",").some((role) => role.trim() === expectedRole) ?? false
  );
}

function messageFrom(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "Could not switch organizations.";
}
