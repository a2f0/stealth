import { AuthPage } from "./AuthPage";
import { authClient } from "./authClient";
import { Library } from "./Library";

export function App() {
  const { data: session, error, isPending, refetch } = authClient.useSession();
  const isResetPage = window.location.pathname === "/reset-password";

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
        initialMode={isResetPage ? "reset" : "sign-in"}
        onAuthenticated={() => refetch()}
      />
    );
  }

  return (
    <Library
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

function LoadingScreen() {
  return (
    <div className="loadingScreen" role="status">
      <span className="srOnly">Loading session</span>
      <span className="brandMark">S</span>
      <span className="loadingPulse" />
    </div>
  );
}
