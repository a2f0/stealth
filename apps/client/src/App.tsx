import { useEffect } from "react";
import { AuthPage } from "./AuthPage";
import { authClient } from "./authClient";
import { Library } from "./Library";

export function App() {
  const { data: session, error, isPending, refetch } = authClient.useSession();
  const isResetPage = window.location.pathname === "/reset-password";
  const verification = verificationFeedback();

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

  return (
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
      onSignOut={async () => {
        const result = await authClient.signOut();
        if (result.error) {
          throw new Error(result.error.message ?? "Could not sign out.");
        }
        await refetch();
      }}
      user={session.user}
    />
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
