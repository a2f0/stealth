import { Icon, type IconName, Logo, promptDialog } from "@tearleads/ui/react";
import {
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
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
  twoFactorEnabled?: boolean | null | undefined;
}

type WorkspacePage =
  | "account"
  | "activity"
  | "audits"
  | "businesses"
  | "contracts"
  | "equipment"
  | "finance"
  | "inbox"
  | "library"
  | "organization"
  | "rootJobs"
  | "rootOrganizations"
  | "rootUsers";

interface WorkspaceShellProps {
  accountLoadError: string | undefined;
  accounts: AccountSession[];
  activePage: WorkspacePage;
  activeOrganizationId: string | undefined;
  activeSessionToken: string;
  canAccessFinance: boolean;
  children: ReactNode;
  contentKey: string | undefined;
  onAccountChange: (sessionToken: string) => Promise<void>;
  onAccountSettings: () => void;
  onAddAccount: () => void;
  onNavigate: (pathname: string) => void;
  onOrganizationChange: (organizationId: string) => Promise<void>;
  onOrganizationCreate: (name: string) => Promise<void>;
  onRefreshAccounts: () => Promise<void>;
  onSignOut: () => Promise<void>;
  organizations: WorkspaceOrganization[];
  user: WorkspaceUser;
}

interface NavigationItem {
  href: string;
  icon: IconName;
  label: string;
  page: WorkspacePage;
}

export function WorkspaceShell({
  children,
  contentKey,
  ...sidebar
}: WorkspaceShellProps) {
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const shellStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
  } as CSSProperties;
  return (
    <div className="shell" style={shellStyle}>
      <Sidebar {...sidebar} />
      <SidebarResizeHandle
        onWidthChange={setSidebarWidth}
        width={sidebarWidth}
      />
      <main className="shellMain" key={contentKey}>
        {children}
      </main>
    </div>
  );
}

function Sidebar({
  accountLoadError,
  accounts,
  activePage,
  activeOrganizationId,
  activeSessionToken,
  canAccessFinance,
  onAccountChange,
  onAccountSettings,
  onAddAccount,
  onNavigate,
  onOrganizationChange,
  onOrganizationCreate,
  onRefreshAccounts,
  onSignOut,
  organizations,
  user,
}: Omit<WorkspaceShellProps, "children" | "contentKey">) {
  const [open, setOpen] = useState(false);
  const sidebar = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useNavigationDismissal(open, sidebar, toggle, () => setOpen(false));
  const navigate = (pathname: string) => {
    setOpen(false);
    onNavigate(pathname);
  };
  const groups = navigationFor(canAccessFinance, hasRole(user.role, "admin"));
  return (
    <aside className="sidebar onDark" data-open={open} ref={sidebar}>
      <div className="sidebarInner">
        <div className="sidebarTop">
          <a
            aria-label="Tearleads home"
            className="sidebarBrand"
            href="/"
            onClick={(event) => handleNavigation(event, "/", navigate)}
          >
            <Logo />
          </a>
          <button
            aria-controls="workspace-navigation"
            aria-expanded={open}
            aria-label={open ? "Close navigation" : "Open navigation"}
            className="button buttonGhost buttonIconOnly sidebarToggle"
            onClick={() => setOpen(!open)}
            ref={toggle}
            type="button"
          >
            <Icon name={open ? "close" : "menu"} size={20} />
          </button>
        </div>
        <div className="sidebarPanel" id="workspace-navigation">
          <OrganizationSwitcher
            activeOrganizationId={activeOrganizationId}
            onOrganizationChange={onOrganizationChange}
            onOrganizationCreate={onOrganizationCreate}
            organizations={organizations}
          />
          <nav aria-label="Workspace" className="sidebarNav">
            {groups.map((group) => (
              <div className="navGroup" key={group.label ?? "main"}>
                {group.label && <p className="navGroupLabel">{group.label}</p>}
                {group.items.map((item) => (
                  <a
                    aria-current={activePage === item.page ? "page" : undefined}
                    className="navItem"
                    href={item.href}
                    key={item.href}
                    onClick={(event) =>
                      handleNavigation(event, item.href, navigate)
                    }
                  >
                    <Icon name={item.icon} size={18} />
                    {item.label}
                  </a>
                ))}
              </div>
            ))}
          </nav>
          <div className="sidebarFooter">
            <AccountControl
              accounts={accounts}
              activeSessionToken={activeSessionToken}
              loadError={accountLoadError}
              onAddAccount={onAddAccount}
              onRefreshAccounts={onRefreshAccounts}
              onSettings={() => {
                setOpen(false);
                onAccountSettings();
              }}
              onSignOut={onSignOut}
              onSwitchAccount={onAccountChange}
              user={user}
            />
          </div>
        </div>
      </div>
    </aside>
  );
}

/**
 * The phone navigation panel closes on Escape (unless a menu inside it owns
 * the key) and when focus moves into the page, so it never covers the
 * focused control.
 */
function useNavigationDismissal(
  open: boolean,
  sidebar: RefObject<HTMLElement | null>,
  toggle: RefObject<HTMLButtonElement | null>,
  close: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // An open menu (or its trigger) handles its own Escape first.
      if (
        event.target instanceof Element &&
        event.target.closest(
          '[role="menu"], [aria-haspopup="menu"][aria-expanded="true"]',
        )
      ) {
        return;
      }
      close();
      toggle.current?.focus();
    };
    const closeWhenFocusLeaves = (event: FocusEvent) => {
      if (
        event.target instanceof Node &&
        !sidebar.current?.contains(event.target)
      ) {
        close();
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("focusin", closeWhenFocusLeaves);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("focusin", closeWhenFocusLeaves);
    };
  }, [close, open, sidebar, toggle]);
}

function navigationFor(canAccessFinance: boolean, isAdmin: boolean) {
  const workspace: NavigationItem[] = [
    { href: "/", icon: "library", label: "Library", page: "library" },
    { href: "/audits", icon: "audits", label: "Audits", page: "audits" },
    { href: "/activity", icon: "layers", label: "Activity", page: "activity" },
    { href: "/inbox", icon: "inbox", label: "Inbox", page: "inbox" },
  ];
  const records: NavigationItem[] = [
    {
      href: "/businesses",
      icon: "businesses",
      label: "Businesses",
      page: "businesses",
    },
    {
      href: "/contracts",
      icon: "contract",
      label: "Contracts",
      page: "contracts",
    },
    {
      href: "/equipment",
      icon: "equipment",
      label: "Equipment",
      page: "equipment",
    },
  ];
  if (canAccessFinance) {
    records.push({
      href: "/finance",
      icon: "finance",
      label: "Finance",
      page: "finance",
    });
  }
  const admin: NavigationItem[] = [
    {
      href: "/organization",
      icon: "organization",
      label: "Organization",
      page: "organization",
    },
  ];
  const groups = [
    { items: workspace, label: undefined },
    { items: records, label: "Records" },
    { items: admin, label: "Admin" },
  ];
  if (isAdmin) {
    groups.push({
      items: [
        {
          href: "/root/users",
          icon: "shield",
          label: "Users",
          page: "rootUsers",
        },
        {
          href: "/root/organizations",
          icon: "organization",
          label: "Organizations",
          page: "rootOrganizations",
        },
        {
          href: "/root/jobs",
          icon: "refresh",
          label: "Jobs",
          page: "rootJobs",
        },
      ],
      label: "Root Admin",
    });
  }
  return groups;
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
        <span className="organizationSwitcherLabel">Organization</span>
        <button
          className="button buttonSm buttonBlock organizationCreateButton"
          disabled={busy}
          onClick={() => void select("create")}
          type="button"
        >
          <Icon name="add" size={16} />
          {busy ? "Creating…" : "Create organization"}
        </button>
        {error && <small role="alert">{error}</small>}
      </div>
    );
  }

  async function select(organizationId: string) {
    if (organizationId === "create") {
      const name = (await askOrganizationName())?.trim();
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
      <label className="field">
        <span className="organizationSwitcherLabel">Organization</span>
        <select
          aria-label="Active organization"
          className="select inputSm"
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

function askOrganizationName() {
  return promptDialog({
    confirmLabel: "Create organization",
    label: "Organization name",
    maxLength: 100,
    required: true,
    title: "Create an organization",
  });
}
