import {
  Banner,
  Button,
  EmptyState,
  Icon,
  Page,
  PageBody,
  PageHeader,
} from "@tearleads/ui/react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { AccountSecurity } from "./AccountSecurity";
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
  organizationPathRequiresAccess,
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
        activeSessionToken={session?.session.token}
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
      onSessionChanged={() => refetch()}
      session={session}
      verificationNotice={verification.notice}
      workspace={workspace}
    />
  );
}

function AuthenticationRoute({
  activeSessionToken,
  addingAccount,
  navigate,
  pathname,
  refetchSession,
  resettingPassword,
  sessionPresent,
  verification,
}: {
  activeSessionToken: string | undefined;
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
        sessionPresent && addingAccount
          ? async () => {
              if (!activeSessionToken) return;
              const result = await authClient.multiSession.setActive({
                sessionToken: activeSessionToken,
              });
              if (result.error) {
                throw new Error(
                  result.error.message ?? "Could not return to your account.",
                );
              }
              await refetchSession();
              navigate(returnTo);
            }
          : undefined
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
  onSessionChanged,
  pathname,
  session,
  verificationNotice,
  workspace,
}: {
  access: ReturnType<typeof useOrganizationAccess>;
  accounts: ReturnType<typeof useAccountSessions>;
  navigate: (pathname: string) => void;
  onSessionChanged: () => Promise<unknown>;
  pathname: string;
  session: AuthenticatedSession;
  verificationNotice: string | undefined;
  workspace: ReturnType<typeof useWorkspaceOrganizations>;
}) {
  if (workspace.isPending) return <LoadingScreen />;
  if (pathname === "/admin" && !hasRole(session.user.role, "admin")) {
    return <AdminAccessDenied onNavigate={() => navigate("/")} />;
  }
  if (organizationPathRequiresAccess(pathname) && access.isPending) {
    return <LoadingScreen />;
  }
  if (
    pathname === "/finance" &&
    !access.twoFactorRequirement &&
    !access.can("finance")
  ) {
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
  const organizationRequirement = organizationPathRequiresAccess(pathname)
    ? access.twoFactorRequirement
    : undefined;
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
      onAccountSecurity={() => navigate("/account/security")}
      onAddAccount={addAccount}
      onNavigate={navigate}
      onOrganizationCreate={workspace.createOrganization}
      onOrganizationChange={workspace.switchOrganization}
      onRefreshAccounts={accounts.refresh}
      onSignOut={accounts.signOutActiveAccount}
      organizations={workspace.organizations}
      user={session.user}
    >
      {organizationRequirement ? (
        <OrganizationTwoFactorRequired
          onSecurity={() => navigate("/account/security")}
          onSignOut={accounts.signOutActiveAccount}
          requirement={organizationRequirement}
        />
      ) : hasWorkspace ||
        ["/account/security", "/admin", "/inbox", "/invite"].includes(
          pathname,
        ) ? (
        contentForPath(
          pathname,
          library,
          navigate,
          workspace,
          addAccount,
          access,
          hasRole(session.user.role, "admin"),
          Boolean(session.user.twoFactorEnabled),
          async () => {
            await onSessionChanged();
            await access.refresh();
          },
        )
      ) : (
        <NoOrganization />
      )}
    </WorkspaceShell>
  );
}

function OrganizationTwoFactorRequired({
  onSecurity,
  onSignOut,
  requirement,
}: {
  onSecurity: () => void;
  onSignOut: () => Promise<void>;
  requirement: "setup" | "verification";
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const needsSetup = requirement === "setup";

  async function signOut() {
    setBusy(true);
    setError(undefined);
    try {
      await onSignOut();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign out.");
      setBusy(false);
    }
  }

  return (
    <Page narrow>
      <PageHeader
        eyebrow="Organization security"
        title="Two-factor authentication required"
      />
      <PageBody>
        <EmptyState
          actions={
            <Button
              busy={busy}
              icon={needsSetup ? "security" : "signOut"}
              onClick={needsSetup ? onSecurity : () => void signOut()}
              variant="primary"
            >
              {needsSetup
                ? "Set up two-factor authentication"
                : busy
                  ? "Signing out…"
                  : "Sign out to verify"}
            </Button>
          }
          icon="lock"
          title={needsSetup ? "Protect your account" : "Verify your sign-in"}
        >
          <p>
            {needsSetup
              ? "This organization requires you to set up an authenticator before you can use its workspace."
              : "This organization requires a sign-in verified with two-factor authentication. Sign out, then sign in again to continue."}
          </p>
          {error && <Banner tone="danger">{error}</Banner>}
        </EmptyState>
      </PageBody>
    </Page>
  );
}

function NoOrganization() {
  return (
    <Page narrow>
      <PageHeader eyebrow="Workspace" title="Create an organization" />
      <PageBody>
        <EmptyState
          icon="organization"
          title="You don’t have an active organization"
        >
          Use the organization control in the sidebar to create one.
        </EmptyState>
      </PageBody>
    </Page>
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
  isPlatformAdmin: boolean,
  twoFactorEnabled: boolean,
  onSecurityChanged: () => Promise<unknown>,
) {
  if (pathname === "/audits" || pathname.startsWith("/audits/")) {
    return (
      <Audits
        isPlatformAdmin={isPlatformAdmin}
        onNavigate={navigate}
        pathname={pathname}
      />
    );
  }
  if (pathname === "/finance") return <Finance />;
  if (pathname === "/businesses") return <Businesses />;
  if (pathname === "/inbox") return <Inbox />;
  if (pathname === "/admin") return <AdminUsers />;
  if (pathname === "/account/security") {
    return (
      <AccountSecurity
        onSecurityChanged={onSecurityChanged}
        twoFactorEnabled={twoFactorEnabled}
      />
    );
  }
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
  if (pathname === "/account/security") return "account" as const;
  if (isOrganizationPath(pathname)) return "organization" as const;
  if (pathname === "/invite") return "organization" as const;
  return "library" as const;
}

function AdminAccessDenied({ onNavigate }: { onNavigate: () => void }) {
  return (
    <FatalState
      action="Return to your library"
      message="Administrator access is required."
      onAction={onNavigate}
    />
  );
}

function FeatureAccessDenied({ onNavigate }: { onNavigate: () => void }) {
  return (
    <FatalState
      action="Return to your library"
      message="Finance group membership is required."
      onAction={onNavigate}
    />
  );
}

function SessionError({ onRetry }: { onRetry: () => void }) {
  return (
    <FatalState
      action="Try again"
      message="We couldn’t load your session."
      onAction={onRetry}
    />
  );
}

function FatalState({
  action,
  message,
  onAction,
}: {
  action: string;
  message: string;
  onAction: () => void;
}) {
  return (
    <div className="fatalState">
      <div className="card fatalCard">
        <span className="emptyStateIcon">
          <Icon name="alert" size={22} />
        </span>
        <h1 className="cardTitle">{message}</h1>
        <Button onClick={onAction} variant="primary">
          {action}
        </Button>
      </div>
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
    <div className="loadingScreen onDark" role="status">
      <span className="srOnly">Loading session</span>
      <span aria-hidden="true" className="brandMark loadingMark">
        T
      </span>
      <span className="loadingPulse" />
    </div>
  );
}
