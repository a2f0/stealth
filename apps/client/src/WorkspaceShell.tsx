import {
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

export interface WorkspaceUser {
  email: string;
  emailVerified: boolean;
  name: string;
  role?: string | null | undefined;
}

interface WorkspaceShellProps {
  activePage: "admin" | "inbox" | "library" | "organization";
  children: ReactNode;
  onNavigate: (pathname: string) => void;
  onSignOut: () => Promise<void>;
  user: WorkspaceUser;
}

export function WorkspaceShell({
  activePage,
  children,
  onNavigate,
  onSignOut,
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
        <nav aria-label="Workspace">
          <a
            className={activePage === "library" ? "navItem active" : "navItem"}
            href="/"
            onClick={(event) => handleNavigation(event, "/", onNavigate)}
          >
            <span className="navIcon">⌁</span> Library
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

      <main>{children}</main>
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
