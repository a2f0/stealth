import {
  Banner,
  Button,
  EmptyState,
  Page,
  PageBody,
  PageHeader,
} from "@tearleads/ui/react";
import { type ReactNode, useState } from "react";
import {
  blockingSeatRequirement,
  OrganizationSeatRequired,
} from "./OrganizationSeatRequired";
import type {
  OrganizationSeatRequirement,
  OrganizationTwoFactorRequirement,
} from "./organizationGroupsApi";
import { organizationPathRequiresAccess } from "./organizationState";

/**
 * Shows what the organization requires before its pages can load:
 * two-factor authentication, or a seat on its Free plan. An owner without a
 * seat can still open Billing to upgrade.
 */
export function OrganizationGate({
  access,
  children,
  navigate,
  pathname,
  signOut,
}: {
  access: {
    seatRequirement: OrganizationSeatRequirement | undefined;
    twoFactorRequirement: OrganizationTwoFactorRequirement | undefined;
  };
  children: ReactNode;
  navigate: (pathname: string) => void;
  pathname: string;
  signOut: () => Promise<void>;
}) {
  if (!organizationPathRequiresAccess(pathname)) return children;
  if (access.twoFactorRequirement) {
    return (
      <OrganizationTwoFactorRequired
        onSecurity={() => navigate("/account/security")}
        onSignOut={signOut}
        requirement={access.twoFactorRequirement}
      />
    );
  }
  const seat = blockingSeatRequirement(access.seatRequirement, pathname);
  return seat ? (
    <OrganizationSeatRequired onNavigate={navigate} requirement={seat} />
  ) : (
    children
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
