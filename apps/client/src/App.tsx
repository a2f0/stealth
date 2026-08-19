import { type ReactNode, useCallback, useEffect, useState } from "react";
import { AdminUsers } from "./AdminUsers";
import { Audits } from "./Audits";
import { AuthPage } from "./AuthPage";
import { useAccountSessions } from "./accountSessions";
import { authClient } from "./authClient";
import { Finance } from "./Finance";
import { Inbox } from "./Inbox";
import { Library } from "./Library";
import { OrganizationInvitation } from "./OrganizationInvitation";
import { OrganizationSettings } from "./OrganizationSettings";
import {
  resolveActiveOrganizationId,
  type WorkspaceOrganization,
} from "./organizationState";
import { hasRole, WorkspaceShell, type WorkspaceUser } from "./WorkspaceShell";

export function App() {
  const { data: session, error, isPending, refetch } = authClient.useSession();
  const [pathname, setPathname] = useState(window.location.pathname);
  const isAddAccountPage = pathname === "/add-account";
  const isResetPage = pathname === "/reset-password";
  const verification = verificationFeedback();
  const workspace = useWorkspaceOrganizations(session, () => refetch());
  const accounts = useAccountSessions(session, () => refetch());

  const navigate = (nextPathname: string) => {
    if (nextPathname === pathname) return;
    window.history.pushState({}, "", nextPathname);
    setPathname(nextPathname);
  };

  useEffect(() => {
    const updatePathname = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", updatePathname);
    return () => window.removeEventListener("popstate", updatePathname);
  }, []);

  useEffect(() => {
    if (verification.shouldClear) {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [verification.shouldClear]);

  if (isPending) {
    return <LoadingScreen />;
  }

  if (error && !isResetPage) {
    return <SessionError onRetry={() => void refetch()} />;
  }

  if (isAddAccountPage || isResetPage || !session) {
    return (
      <AuthenticationRoute
        addingAccount={isAddAccountPage}
        navigate={navigate}
        pathname={pathname}
        refetchSession={() => refetch()}
        resettingPassword={isResetPage}
        sessionPresent={Boolean(session)}
        verification={verification}
      />
    );
  }

  return (
    <AuthenticatedWorkspace
      accounts={accounts}
      navigate={navigate}
      pathname={pathname}
      session={session}
      verificationNotice={verification.notice}
      workspace={workspace}
    />
  );
}

function AuthenticationRoute({
  addingAccount,
  navigate,
  pathname,
  refetchSession,
  resettingPassword,
  sessionPresent,
  verification,
}: {
  addingAccount: boolean;
  navigate: (pathname: string) => void;
  pathname: string;
  refetchSession: () => Promise<unknown>;
  resettingPassword: boolean;
  sessionPresent: boolean;
  verification: ReturnType<typeof verificationFeedback>;
}) {
  const invitationNotice =
    pathname === "/invite"
      ? "Sign in or create an account with the invited email address to continue."
      : verification.notice;
  return (
    <AuthPage
      initialError={verification.error}
      initialMode={resettingPassword ? "reset" : "sign-in"}
      initialNotice={
        addingAccount
          ? "Sign in to keep another account available on this browser."
          : invitationNotice
      }
      onAuthenticated={async () => {
        await refetchSession();
        if (addingAccount) navigate("/");
      }}
      onCancel={
        sessionPresent && addingAccount ? () => navigate("/") : undefined
      }
      variant={addingAccount ? "add-account" : "default"}
    />
  );
}

interface AuthenticatedSession extends OrganizationSession {
  session: OrganizationSession["session"] & { token: string };
  user: WorkspaceUser & { id: string };
}

function AuthenticatedWorkspace({
  accounts,
  navigate,
  pathname,
  session,
  verificationNotice,
  workspace,
}: {
  accounts: ReturnType<typeof useAccountSessions>;
  navigate: (pathname: string) => void;
  pathname: string;
  session: AuthenticatedSession;
  verificationNotice: string | undefined;
  workspace: ReturnType<typeof useWorkspaceOrganizations>;
}) {
  if (
    ["/admin", "/inbox"].includes(pathname) &&
    !hasRole(session.user.role, "admin")
  ) {
    return <AdminAccessDenied onNavigate={() => navigate("/")} />;
  }
  const library = (
    <Library
      initialNotice={verificationNotice}
      onResendVerification={() => resendVerification(session.user.email)}
      user={session.user}
    />
  );
  const contentKey =
    pathname === "/invite"
      ? "organization-invitation"
      : `${session.user.id}:${workspace.activeOrganizationId ?? ""}`;
  return (
    <WorkspaceShell
      accountLoadError={accounts.loadError}
      accounts={accounts.accounts}
      activePage={activePageFor(pathname)}
      activeOrganizationId={workspace.activeOrganizationId}
      activeSessionToken={session.session.token}
      contentKey={contentKey}
      onAccountChange={accounts.switchAccount}
      onAddAccount={() => navigate("/add-account")}
      onNavigate={navigate}
      onOrganizationChange={workspace.switchOrganization}
      onRefreshAccounts={accounts.refresh}
      onSignOut={accounts.signOutActiveAccount}
      organizations={workspace.organizations}
      user={session.user}
    >
      {contentForPath(pathname, library, navigate, workspace.refresh)}
    </WorkspaceShell>
  );
}

async function resendVerification(email: string) {
  const result = await authClient.sendVerificationEmail({
    callbackURL: `${window.location.origin}/?verified=true`,
    email,
  });
  if (result.error) {
    throw new Error(
      result.error.message ?? "Could not send verification email.",
    );
  }
}

interface OrganizationSession {
  session: { activeOrganizationId?: string | null | undefined };
  user: { id: string };
}

function useWorkspaceOrganizations(
  session: OrganizationSession | null | undefined,
  refetchSession: () => Promise<unknown>,
) {
  const [organizations, setOrganizations] = useState<WorkspaceOrganization[]>(
    [],
  );
  const loadOrganizations = useCallback(async () => {
    const result = await authClient.organization.list();
    if (result.error) {
      throw new Error(
        result.error.message ?? "Could not load your organizations.",
      );
    }
    setOrganizations((result.data ?? []).map(({ id, name }) => ({ id, name })));
  }, []);
  const signedInUserId = session?.user.id;
  useEffect(() => {
    if (!signedInUserId) {
      setOrganizations([]);
      return;
    }
    void loadOrganizations().catch(() => setOrganizations([]));
  }, [loadOrganizations, signedInUserId]);
  const activeOrganizationId = resolveActiveOrganizationId(
    session?.session.activeOrganizationId,
    undefined,
    organizations,
  );
  const switchOrganization = async (organizationId: string) => {
    const result = await authClient.organization.setActive({ organizationId });
    if (result.error) {
      throw new Error(
        result.error.message ?? "Could not switch organizations.",
      );
    }
    await refetchSession();
  };
  const refresh = async () => {
    await loadOrganizations();
    await refetchSession();
  };
  return { activeOrganizationId, organizations, refresh, switchOrganization };
}

function contentForPath(
  pathname: string,
  library: ReactNode,
  navigate: (pathname: string) => void,
  refreshWorkspace: () => Promise<void>,
) {
  if (pathname === "/audits" || pathname.startsWith("/audits/")) {
    return <Audits onNavigate={navigate} pathname={pathname} />;
  }
  if (pathname === "/finance") return <Finance />;
  if (pathname === "/inbox") return <Inbox />;
  if (pathname === "/admin") return <AdminUsers />;
  if (pathname === "/organization") return <OrganizationSettings />;
  if (pathname === "/invite") {
    return (
      <OrganizationInvitation
        invitationId={new URLSearchParams(window.location.search).get("id")}
        onAccepted={refreshWorkspace}
        onNavigate={() => navigate("/organization")}
      />
    );
  }
  return library;
}

function activePageFor(pathname: string) {
  if (pathname === "/audits" || pathname.startsWith("/audits/")) {
    return "audits" as const;
  }
  if (pathname === "/finance") return "finance" as const;
  if (pathname === "/inbox") return "inbox" as const;
  if (pathname === "/admin") return "admin" as const;
  if (pathname === "/organization") return "organization" as const;
  if (pathname === "/invite") return "organization" as const;
  return "library" as const;
}

function AdminAccessDenied({ onNavigate }: { onNavigate: () => void }) {
  return (
    <div className="fatalState">
      <p>Administrator access is required.</p>
      <button onClick={onNavigate} type="button">
        Return to your library
      </button>
    </div>
  );
}

function SessionError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="fatalState">
      <p>We couldn’t load your session.</p>
      <button onClick={onRetry} type="button">
        Try again
      </button>
    </div>
  );
}

function verificationFeedback() {
  const parameters = new URLSearchParams(window.location.search);
  if (parameters.get("verified") !== "true") {
    return { shouldClear: false };
  }

  if (parameters.has("error")) {
    return {
      error:
        "That verification link is invalid or expired. Request a new one after signing in.",
      shouldClear: true,
    };
  }

  return {
    notice: "Email verified. Thanks for confirming your address.",
    shouldClear: true,
  };
}

function LoadingScreen() {
  return (
    <div className="loadingScreen" role="status">
      <span className="srOnly">Loading session</span>
      <span className="brandMark">S</span>
      <span className="loadingPulse" />
    </div>
  );
}
