import { type ReactNode, useState } from "react";

export interface WorkspaceUser {
  email: string;
  emailVerified: boolean;
  name: string;
  role?: string | null | undefined;
}

interface WorkspaceShellProps {
  activePage: "admin" | "library";
  children: ReactNode;
  onSignOut: () => Promise<void>;
  user: WorkspaceUser;
}

export function WorkspaceShell({
  activePage,
  children,
  onSignOut,
  user,
}: WorkspaceShellProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

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
    <div className="shell">
      <aside className="sidebar">
        <a aria-label="Stealth home" className="brand" href="/">
          <span className="brandMark">S</span>
          <span>stealth</span>
        </a>
        <nav aria-label="Workspace">
          <a
            className={activePage === "library" ? "navItem active" : "navItem"}
            href="/"
          >
            <span className="navIcon">⌁</span> Library
          </a>
          {hasRole(user.role, "admin") && (
            <a
              className={activePage === "admin" ? "navItem active" : "navItem"}
              href="/admin"
            >
              <span className="navIcon">◎</span> Users
            </a>
          )}
        </nav>
        <div className="accountBlock">
          <span className="accountAvatar">{initialsFor(user.name)}</span>
          <span className="accountIdentity">
            <strong>{user.name}</strong>
            <span>{user.email}</span>
          </span>
          <button
            aria-label="Sign out"
            className="signOutButton"
            disabled={busy}
            onClick={() => void signOut()}
            title="Sign out"
            type="button"
          >
            ↪
          </button>
        </div>
        {error && (
          <p className="sidebarError" role="alert">
            {error}
          </p>
        )}
        <div className="sidebarFoot">
          <span className="statusDot" /> Cloudflare connected
        </div>
      </aside>

      <main>{children}</main>
    </div>
  );
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
