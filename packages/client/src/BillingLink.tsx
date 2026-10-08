import { Banner, ButtonLink } from "@tearleads/ui/react";
import { handleNavigation } from "./workspacePaths";

export const billingPath = "/organization/billing";

/** An error whose fix is a Pro upgrade on the Billing page. */
export class UpgradeRequiredError extends Error {
  readonly code = "UPGRADE_REQUIRED";
}

export interface ErrorNotice {
  message: string;
  /** The API marked it `UPGRADE_REQUIRED`, so Billing can resolve it. */
  upgrade: boolean;
}

export function errorNotice(cause: unknown, fallback: string): ErrorNotice {
  if (!(cause instanceof Error)) return { message: fallback, upgrade: false };
  return {
    message: cause.message,
    upgrade: "code" in cause && cause.code === "UPGRADE_REQUIRED",
  };
}

/** Opens Billing in place; a modified click opens it in a new tab. */
export function BillingLink({
  onNavigate,
  variant = "secondary",
}: {
  onNavigate: (pathname: string) => void;
  variant?: "primary" | "secondary";
}) {
  return (
    <ButtonLink
      href={billingPath}
      onClick={(event) => handleNavigation(event, billingPath, onNavigate)}
      size={variant === "primary" ? undefined : "sm"}
      variant={variant}
    >
      Go to Billing
    </ButtonLink>
  );
}

/** A danger banner that links to Billing when an upgrade resolves the error. */
export function ErrorBanner({
  error,
  onNavigate,
}: {
  error: ErrorNotice | undefined;
  onNavigate: (pathname: string) => void;
}) {
  if (!error) return null;
  return (
    <Banner
      actions={error.upgrade ? <BillingLink onNavigate={onNavigate} /> : null}
      tone="danger"
    >
      {error.message}
    </Banner>
  );
}
