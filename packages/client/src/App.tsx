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
import { AccountSettings } from "./AccountSettings";
import { Activity } from "./Activity";
import { AdminJobs } from "./AdminJobs";
import { AdminOrganizations } from "./AdminOrganizations";
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
import { Contracts } from "./Contracts";
import { Equipment } from "./Equipment";
import { Finance } from "./Finance";
import { isFinancePath } from "./financePages";
import { Inbox } from "./Inbox";
import { Library } from "./Library";
import { OrganizationInvitation } from "./OrganizationInvitation";
import { OrganizationSettings } from "./OrganizationSettings";
import { getWorkspaceOrganizations } from "./organizationSettingsApi";
import {
  createOrganizationSlug,
  isOrganizationPath,
  isRootAdminPath,
  organizationPathRequiresAccess,
  resolveActiveOrganizationId,
  type WorkspaceOrganization,
} from "./organizationState";
import { SigningPage } from "./SigningPage";
import { useOrganizationAccess } from "./useOrganizationAccess";
import { hasRole, WorkspaceShell, type WorkspaceUser } from "./WorkspaceShell";
import {
  isBusinessesPath,
  isContractsPath,
  isEquipmentPath,
  signingTokenForPath,
} from "./workspacePaths";

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

  // Signers open these from emailed links, signed in or not.
  const signingToken = signingTokenForPath(pathname);
  if (signingToken) return <SigningPage token={signingToken} />;

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
      initialNoticeTone={
        !addingAccount && pathname !== "/invite" && verification.notice
          ? "success"
          : "info"
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
  user: WorkspaceUser & {
    defaultOrganizationId?: string | null | undefined;
    id: string;
  };
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
  const blocked = blockedWorkspaceContent(
    access,
    navigate,
    pathname,
    session,
    workspace,
  );
  if (blocked) return blocked;
  const library = (
    <Library
      initialNotice={verificationNotice}
      onNavigate={navigate}
      onResendVerification={() => resendVerification(session.user.email)}
      pathname={pathname}
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
  const showContent =
    hasWorkspace ||
    !organizationPathRequiresAccess(pathname) ||
    pathname === "/inbox";
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
      onAccountSettings={() => navigate("/account")}
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
      ) : showContent ? (
        contentForPath(
          pathname,
          library,
          navigate,
          workspace,
          addAccount,
          access,
          hasRole(session.user.role, "admin"),
          session.user.defaultOrganizationId,
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

/** A loading or access-denied screen when the path can't be shown yet. */
function blockedWorkspaceContent(
  access: ReturnType<typeof useOrganizationAccess>,
  navigate: (pathname: string) => void,
  pathname: string,
  session: AuthenticatedSession,
  workspace: ReturnType<typeof useWorkspaceOrganizations>,
) {
  if (workspace.isPending) return <LoadingScreen />;
  if (isRootAdminPath(pathname) && !hasRole(session.user.role, "admin")) {
    return <AdminAccessDenied onNavigate={() => navigate("/")} />;
  }
  if (organizationPathRequiresAccess(pathname) && access.isPending) {
    return <LoadingScreen />;
  }
  if (
    isFinancePath(pathname) &&
    !access.twoFactorRequirement &&
    !access.can("finance")
  ) {
    return <FeatureAccessDenied onNavigate={() => navigate("/")} />;
  }
  return undefined;
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
  defaultOrganizationId: string | null | undefined,
  twoFactorEnabled: boolean,
  onSecurityChanged: () => Promise<unknown>,
) {
  if (pathname === "/activity") return <Activity onNavigate={navigate} />;
  if (pathname === "/audits" || pathname.startsWith("/audits/")) {
    return (
      <Audits
        isPlatformAdmin={isPlatformAdmin}
        onNavigate={navigate}
        pathname={pathname}
      />
    );
  }
  if (isFinancePath(pathname)) {
    return <Finance onNavigate={navigate} pathname={pathname} />;
  }
  if (isBusinessesPath(pathname)) {
    return <Businesses onNavigate={navigate} pathname={pathname} />;
  }
  if (isContractsPath(pathname)) {
    return <Contracts onNavigate={navigate} pathname={pathname} />;
  }
  if (isEquipmentPath(pathname)) {
    return <Equipment onNavigate={navigate} pathname={pathname} />;
  }
  if (pathname === "/inbox") {
    return (
      <Inbox canAccessFinance={access.can("finance")} onNavigate={navigate} />
    );
  }
  if (pathname === "/root/jobs") return <AdminJobs />;
  if (pathname === "/root/users") return <AdminUsers />;
  if (pathname === "/root/organizations") return <AdminOrganizations />;
  if (pathname === "/account" || pathname === "/account/security") {
    return (
      <AccountSettings
        defaultOrganizationId={defaultOrganizationId}
        onNavigate={navigate}
        onSessionChanged={onSecurityChanged}
        organizations={workspace.organizations}
        pathname={pathname}
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
  if (pathname === "/activity") return "activity" as const;
  if (pathname === "/audits" || pathname.startsWith("/audits/")) {
    return "audits" as const;
  }
  if (isFinancePath(pathname)) return "finance" as const;
  if (isBusinessesPath(pathname)) return "businesses" as const;
  if (isContractsPath(pathname)) return "contracts" as const;
  if (isEquipmentPath(pathname)) return "equipment" as const;
  if (pathname === "/inbox") return "inbox" as const;
  if (pathname === "/root/jobs") return "rootJobs" as const;
  if (pathname === "/root/users") return "rootUsers" as const;
  if (pathname === "/root/organizations") return "rootOrganizations" as const;
  if (pathname === "/account" || pathname === "/account/security") {
    return "account" as const;
  }
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
