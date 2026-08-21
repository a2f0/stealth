import { type ReactNode, useCallback, useEffect, useState } from "react";
import { AdminUsers } from "./AdminUsers";
import { Audits } from "./Audits";
import { type AuthenticationAction, AuthPage } from "./AuthPage";
import {
  accountReturnPath,
  addAccountPath,
  invitationIdForPath,
  workspaceContentKey,
} from "./accountNavigation";
import { useAccountSessions } from "./accountSessions";
import { authClient } from "./authClient";
import { Businesses } from "./Businesses";
import { Finance } from "./Finance";
import { Inbox } from "./Inbox";
import { Library } from "./Library";
import { OrganizationInvitation } from "./OrganizationInvitation";
import { OrganizationSettings } from "./OrganizationSettings";
import { getWorkspaceOrganizations } from "./organizationSettingsApi";
import {
  createOrganizationSlug,
  isOrganizationPath,
  resolveActiveOrganizationId,
  type WorkspaceOrganization,
} from "./organizationState";
import { useOrganizationAccess } from "./useOrganizationAccess";
import { hasRole, WorkspaceShell, type WorkspaceUser } from "./WorkspaceShell";

export function App() {
  const { data: session, error, isPending, refetch } = authClient.useSession();
  const [pathname, setPathname] = useState(window.location.pathname);
  const isAddAccountPage = pathname === "/add-account";
  const isResetPage = pathname === "/reset-password";
  const verification = verificationFeedback();
  const workspace = useWorkspaceOrganizations(session, () => refetch());
  const access = useOrganizationAccess(
    session?.user.id,
    workspace.activeOrganizationId,
  );
  const accounts = useAccountSessions(session, () => refetch());

  const navigate = (nextPathname: string) => {
    const destination = new URL(nextPathname, window.location.origin);
    if (destination.origin !== window.location.origin) return;
    const nextLocation = `${destination.pathname}${destination.search}${destination.hash}`;
    const currentLocation = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextLocation === currentLocation) return;
    window.history.pushState({}, "", nextLocation);
    setPathname(destination.pathname);
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
      access={access}
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
  const returnTo = accountReturnPath(
    window.location.search,
    window.location.origin,
  );
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
      onAuthenticated={async (action: AuthenticationAction) => {
        const invitationId =
          action === "sign-up"
            ? invitationIdForPath(
                addingAccount ? returnTo : currentLocation(),
                window.location.origin,
              )
            : undefined;
        if (invitationId) {
          const result = await authClient.organization.acceptInvitation({
            invitationId,
          });
          if (result.error) {
            await refetchSession();
            throw new Error(
              result.error.message ?? "Could not accept this invitation.",
            );
          }
        }
        await refetchSession();
        if (invitationId) {
          navigate("/organization");
        } else if (addingAccount) {
          navigate(returnTo);
        }
      }}
      onCancel={
        sessionPresent && addingAccount ? () => navigate(returnTo) : undefined
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
  access,
  accounts,
  navigate,
  pathname,
  session,
  verificationNotice,
  workspace,
}: {
  access: ReturnType<typeof useOrganizationAccess>;
  accounts: ReturnType<typeof useAccountSessions>;
  navigate: (pathname: string) => void;
  pathname: string;
  session: AuthenticatedSession;
  verificationNotice: string | undefined;
  workspace: ReturnType<typeof useWorkspaceOrganizations>;
}) {
  if (workspace.isPending) return <LoadingScreen />;
  if (pathname === "/admin" && !hasRole(session.user.role, "admin")) {
    return <AdminAccessDenied onNavigate={() => navigate("/")} />;
  }
  if (pathname === "/finance" && access.isPending) return <LoadingScreen />;
  if (pathname === "/finance" && !access.can("finance")) {
    return <FeatureAccessDenied onNavigate={() => navigate("/")} />;
  }
  const library = (
    <Library
      initialNotice={verificationNotice}
      onResendVerification={() => resendVerification(session.user.email)}
      user={session.user}
    />
  );
  const contentKey = workspaceContentKey(
    pathname,
    session.user.id,
    workspace.activeOrganizationId,
  );
  const addAccount = () => navigate(addAccountPath(currentLocation()));
  const hasWorkspace = workspace.organizations.length > 0;
  return (
    <WorkspaceShell
      accountLoadError={accounts.loadError}
      accounts={accounts.accounts}
      activePage={activePageFor(pathname)}
      activeOrganizationId={workspace.activeOrganizationId}
      activeSessionToken={session.session.token}
      canAccessFinance={access.can("finance")}
      contentKey={contentKey}
      onAccountChange={accounts.switchAccount}
      onAddAccount={addAccount}
      onNavigate={navigate}
      onOrganizationCreate={workspace.createOrganization}
      onOrganizationChange={workspace.switchOrganization}
      onRefreshAccounts={accounts.refresh}
      onSignOut={accounts.signOutActiveAccount}
      organizations={workspace.organizations}
      user={session.user}
    >
      {hasWorkspace || ["/admin", "/inbox", "/invite"].includes(pathname) ? (
        contentForPath(
          pathname,
          library,
          navigate,
          workspace,
          addAccount,
          access,
        )
      ) : (
        <NoOrganization />
      )}
    </WorkspaceShell>
  );
}

function NoOrganization() {
  return (
    <>
      <header className="topbar">
        <div>
          <p className="eyebrow">Workspace</p>
          <h1>Create an organization</h1>
        </div>
      </header>
      <section className="content">
        <div className="emptyState compactEmptyState">
          <div className="emptyGlyph">◇</div>
          <h3>You don’t have an active organization.</h3>
          <p>Use the organization control in the sidebar to create one.</p>
        </div>
      </section>
    </>
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
  user: {
    defaultOrganizationId?: string | null | undefined;
    id: string;
  };
}

function useWorkspaceOrganizations(
  session: OrganizationSession | null | undefined,
  refetchSession: () => Promise<unknown>,
) {
  const [organizations, setOrganizations] = useState<
    WorkspaceOrganization[] | undefined
  >();
  const loadOrganizations = useCallback(async () => {
    setOrganizations(await getWorkspaceOrganizations());
  }, []);
  const signedInUserId = session?.user.id;
  useEffect(() => {
    if (!signedInUserId) {
      setOrganizations(undefined);
      return;
    }
    void loadOrganizations().catch(() => setOrganizations([]));
  }, [loadOrganizations, signedInUserId]);
  const activeOrganizationId = organizations
    ? resolveActiveOrganizationId(
        session?.session.activeOrganizationId,
        session?.user.defaultOrganizationId,
        organizations,
      )
    : (session?.session.activeOrganizationId ??
      session?.user.defaultOrganizationId ??
      undefined);
  const createOrganization = async (name: string) => {
    const result = await authClient.organization.create({
      name,
      slug: createOrganizationSlug(name, crypto.randomUUID()),
    });
    if (result.error) {
      throw new Error(
        result.error.message ?? "Could not create this organization.",
      );
    }
    await loadOrganizations();
    await refetchSession();
  };
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
  return {
    activeOrganizationId,
    createOrganization,
    isPending: organizations === undefined,
    organizations: organizations ?? [],
    refresh,
    switchOrganization,
  };
}

function contentForPath(
  pathname: string,
  library: ReactNode,
  navigate: (pathname: string) => void,
  workspace: ReturnType<typeof useWorkspaceOrganizations>,
  addAccount: () => void,
  access: ReturnType<typeof useOrganizationAccess>,
) {
  if (pathname === "/audits" || pathname.startsWith("/audits/")) {
    return <Audits onNavigate={navigate} pathname={pathname} />;
  }
  if (pathname === "/finance") return <Finance />;
  if (pathname === "/businesses") return <Businesses />;
  if (pathname === "/inbox") return <Inbox />;
  if (pathname === "/admin") return <AdminUsers />;
  if (isOrganizationPath(pathname)) {
    return (
      <OrganizationSettings
        activeOrganizationId={workspace.activeOrganizationId}
        accessError={access.loadError}
        memberRole={access.memberRole}
        onAccessChanged={access.refresh}
        onNavigate={navigate}
        onWorkspaceChanged={workspace.refresh}
        organizations={workspace.organizations}
        ownerCount={access.ownerCount}
        pathname={pathname}
      />
    );
  }
  if (pathname === "/invite") {
    return (
      <OrganizationInvitation
        invitationId={new URLSearchParams(window.location.search).get("id")}
        onAccepted={workspace.refresh}
        onNavigate={() => navigate("/organization")}
        onUseAnotherAccount={addAccount}
      />
    );
  }
  return library;
}

function currentLocation() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function activePageFor(pathname: string) {
  if (pathname === "/audits" || pathname.startsWith("/audits/")) {
    return "audits" as const;
  }
  if (pathname === "/finance") return "finance" as const;
  if (pathname === "/businesses") return "businesses" as const;
  if (pathname === "/inbox") return "inbox" as const;
  if (pathname === "/admin") return "admin" as const;
  if (isOrganizationPath(pathname)) return "organization" as const;
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

function FeatureAccessDenied({ onNavigate }: { onNavigate: () => void }) {
  return (
    <div className="fatalState">
      <p>Finance group membership is required.</p>
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
