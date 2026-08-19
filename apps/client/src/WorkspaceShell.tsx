import {
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import type { WorkspaceOrganization } from "./organizationState";

export interface WorkspaceUser {
  email: string;
  emailVerified: boolean;
  name: string;
  role?: string | null | undefined;
}

interface WorkspaceShellProps {
  activePage:
    | "admin"
    | "audits"
    | "finance"
    | "inbox"
    | "library"
    | "organization";
  activeOrganizationId: string | undefined;
  children: ReactNode;
  contentKey: string | undefined;
  onNavigate: (pathname: string) => void;
  onOrganizationChange: (organizationId: string) => Promise<void>;
  onSignOut: () => Promise<void>;
  organizations: WorkspaceOrganization[];
  user: WorkspaceUser;
}

export function WorkspaceShell({
  activePage,
  activeOrganizationId,
  children,
  contentKey,
  onNavigate,
  onOrganizationChange,
  onSignOut,
  organizations,
  user,
}: WorkspaceShellProps) {
  return (
    <div className="shell">
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
          <a
            className={activePage === "finance" ? "navItem active" : "navItem"}
            href="/finance"
            onClick={(event) => handleNavigation(event, "/finance", onNavigate)}
          >
            <span className="navIcon">$</span> Finance
          </a>
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
        <AccountControl onSignOut={onSignOut} user={user} />
      </aside>

      <main key={contentKey}>{children}</main>
    </div>
  );
}

function OrganizationSwitcher({
  activeOrganizationId,
  onOrganizationChange,
  organizations,
}: {
  activeOrganizationId: string | undefined;
  onOrganizationChange: (organizationId: string) => Promise<void>;
  organizations: WorkspaceOrganization[];
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (organizations.length === 0 || !activeOrganizationId) return null;

  async function select(organizationId: string) {
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
        </select>
      </label>
      {error && <small role="alert">{error}</small>}
    </div>
  );
}

function AccountControl({
  onSignOut,
  user,
}: {
  onSignOut: () => Promise<void>;
  user: WorkspaceUser;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const closeOnOutsideClick = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !menu.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  async function signOut() {
    setBusy(true);
    setError(undefined);
    try {
      await onSignOut();
    } catch (cause) {
      setError(messageFrom(cause));
      setBusy(false);
    }
  }

  return (
    <div className="accountBlock">
      <span className="accountAvatar">{initialsFor(user.name)}</span>
      <span className="accountIdentity">
        <strong>{user.name}</strong>
        <span>{user.email}</span>
      </span>
      <div className="accountMenu" ref={menu}>
        <button
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label="Account menu"
          className="accountMenuButton"
          disabled={busy}
          onClick={() => {
            setError(undefined);
            setOpen((current) => !current);
          }}
          ref={trigger}
          type="button"
        >
          ⋮
        </button>
        {open && (
          <div className="accountMenuPopover" role="menu">
            {error && (
              <p className="accountMenuError" role="alert">
                {error}
              </p>
            )}
            <button
              className="accountMenuItem"
              disabled={busy}
              onClick={() => void signOut()}
              role="menuitem"
              type="button"
            >
              {busy ? "Signing out…" : "Sign out"}
            </button>
          </div>
        )}
      </div>
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

function initialsFor(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "?"
  );
}

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not sign out.";
}
