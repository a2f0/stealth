import { type ReactNode, useEffect, useState } from "react";
import { AdminUsers } from "./AdminUsers";
import { AuthPage } from "./AuthPage";
import { authClient } from "./authClient";
import { Inbox } from "./Inbox";
import { Library } from "./Library";
import { OrganizationSettings } from "./OrganizationSettings";
import { hasRole, WorkspaceShell } from "./WorkspaceShell";

export function App() {
  const { data: session, error, isPending, refetch } = authClient.useSession();
  const [pathname, setPathname] = useState(window.location.pathname);
  const requiresAdmin = ["/admin", "/inbox"].includes(pathname);
  const isResetPage = pathname === "/reset-password";
  const verification = verificationFeedback();

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
    return (
      <div className="fatalState">
        <p>We couldn’t load your session.</p>
        <button onClick={() => void refetch()} type="button">
          Try again
        </button>
      </div>
    );
  }

  if (isResetPage || !session) {
    return (
      <AuthPage
        initialError={verification.error}
        initialMode={isResetPage ? "reset" : "sign-in"}
        initialNotice={verification.notice}
        onAuthenticated={() => refetch()}
      />
    );
  }

  const onSignOut = async () => {
    const result = await authClient.signOut();
    if (result.error) {
      throw new Error(result.error.message ?? "Could not sign out.");
    }
    await refetch();
  };

  const navigate = (nextPathname: string) => {
    if (nextPathname === pathname) return;
    window.history.pushState({}, "", nextPathname);
    setPathname(nextPathname);
  };

  if (requiresAdmin && !hasRole(session.user.role, "admin")) {
    return <AdminAccessDenied onNavigate={() => navigate("/")} />;
  }

  const library = (
    <Library
      initialNotice={verification.notice}
      onResendVerification={async () => {
        const result = await authClient.sendVerificationEmail({
          callbackURL: `${window.location.origin}/?verified=true`,
          email: session.user.email,
        });
        if (result.error) {
          throw new Error(
            result.error.message ?? "Could not send verification email.",
          );
        }
      }}
      user={session.user}
    />
  );

  return (
    <WorkspaceShell
      activePage={activePageFor(pathname)}
      onNavigate={navigate}
      onSignOut={onSignOut}
      user={session.user}
    >
      {contentForPath(pathname, library)}
    </WorkspaceShell>
  );
}

function contentForPath(pathname: string, library: ReactNode) {
  if (pathname === "/inbox") return <Inbox />;
  if (pathname === "/admin") return <AdminUsers />;
  if (pathname === "/organization") return <OrganizationSettings />;
  return library;
}

function activePageFor(pathname: string) {
  if (pathname === "/inbox") return "inbox" as const;
  if (pathname === "/admin") return "admin" as const;
  if (pathname === "/organization") return "organization" as const;
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
