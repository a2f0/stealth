import { useCallback, useEffect, useRef, useState } from "react";
import {
  type BillingStatus,
  createCheckoutSession,
  createPortalSession,
  getBillingStatus,
  redirectToCurrentBillingSession,
} from "./billingApi";

export function OrganizationBilling({
  organizationId,
}: {
  organizationId: string;
}) {
  const [status, setStatus] = useState<BillingStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const loadSequence = useRef(0);
  const actionSequence = useRef(0);
  const redirect = createBillingAction(
    actionSequence,
    setBusy,
    setError,
    setNotice,
  );
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setStatus(undefined);
    setError(undefined);
    setNotice(undefined);
    setBusy(false);
    if (!organizationId) return;
    const query = new URLSearchParams(window.location.search);
    const sessionId = query.get("session_id") ?? undefined;
    try {
      const nextStatus = await getBillingStatus(sessionId);
      if (sequence !== loadSequence.current) return;
      setStatus(nextStatus);
      setNotice(checkoutNotice(query));
      clearCheckoutQuery(query);
    } catch (cause) {
      if (sequence === loadSequence.current) {
        setError(messageFrom(cause));
      }
    }
  }, [organizationId]);
  useBillingReload(load, loadSequence, actionSequence);

  if (!status && !error) {
    return <SettingsLoading />;
  }
  return (
    <div className="billingSettings">
      {error && <div className="errorBanner">{error}</div>}
      {notice && (
        <div aria-live="polite" className="successBanner pageBanner">
          {notice}
        </div>
      )}
      {status && (
        <>
          <section className="settingsCard billingSummaryCard">
            <div>
              <p className="eyebrow">Current plan</p>
              <h2>{status.plan === "pro" ? "Pro" : "Free"}</h2>
              <p>{currentUsage(status)}</p>
            </div>
            <span className={`billingPlanBadge ${status.plan}`}>
              {status.billing.status ?? status.plan}
            </span>
            {status.billing.cancelAtPeriodEnd && (
              <p className="billingNotice">
                Cancellation is scheduled
                {status.billing.currentPeriodEnd
                  ? ` for ${formatDate(status.billing.currentPeriodEnd)}`
                  : " for the end of the billing period"}
                .
              </p>
            )}
          </section>
          <div className="billingPlans">
            <PlanCard
              action={status.plan === "free" ? "Current plan" : undefined}
              features={["1 user", "5 form templates", "30-day audit history"]}
              name="Free"
              price="$0"
            />
            <PlanCard
              action={
                status.canManage
                  ? status.plan === "pro"
                    ? "Manage billing"
                    : "Upgrade to Pro"
                  : undefined
              }
              busy={busy}
              featured
              features={[
                "$10 for each active user",
                "Unlimited form templates",
                "Unlimited audit history",
              ]}
              name="Pro"
              onAction={() =>
                void redirect(status.plan === "pro" ? "portal" : "checkout")
              }
              price="$10/user/mo"
            />
          </div>
          {!status.canManage && (
            <p className="billingManagerNote">
              An organization owner or admin can change the plan and manage
              payment details.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function createBillingAction(
  actionSequence: { current: number },
  setBusy: (value: boolean) => void,
  setError: (value: string | undefined) => void,
  setNotice: (value: string | undefined) => void,
) {
  return async (action: "checkout" | "portal") => {
    const sequence = ++actionSequence.current;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const request =
        action === "checkout" ? createCheckoutSession : createPortalSession;
      await redirectToCurrentBillingSession(
        request,
        () => sequence === actionSequence.current,
        (url) => window.location.assign(url),
      );
    } catch (cause) {
      if (sequence === actionSequence.current) {
        setError(messageFrom(cause));
        setBusy(false);
      }
    }
  };
}

function useBillingReload(
  load: () => Promise<void>,
  loadSequence: { current: number },
  actionSequence: { current: number },
) {
  useEffect(() => {
    void load();
    return () => {
      loadSequence.current += 1;
      actionSequence.current += 1;
    };
  }, [actionSequence, load, loadSequence]);
}

function checkoutNotice(query: URLSearchParams) {
  const checkout = query.get("checkout");
  if (checkout === "success") return "Your Pro subscription is active.";
  if (checkout === "canceled") {
    return "Checkout was canceled. Your plan has not changed.";
  }
  return undefined;
}

function clearCheckoutQuery(query: URLSearchParams) {
  if (query.has("checkout") || query.has("session_id")) {
    window.history.replaceState({}, "", "/organization/billing");
  }
}

function PlanCard({
  action,
  busy = false,
  featured = false,
  features,
  name,
  onAction,
  price,
}: {
  action?: string | undefined;
  busy?: boolean;
  featured?: boolean;
  features: string[];
  name: string;
  onAction?: () => void;
  price: string;
}) {
  return (
    <section className={featured ? "billingPlan featured" : "billingPlan"}>
      <div>
        <p className="eyebrow">{name}</p>
        <h2>{price}</h2>
      </div>
      <ul>
        {features.map((feature) => (
          <li key={feature}>{feature}</li>
        ))}
      </ul>
      {action && (
        <button
          className={onAction ? "primaryButton" : undefined}
          disabled={busy || !onAction}
          onClick={onAction}
          type="button"
        >
          {busy ? "Opening Stripe…" : action}
        </button>
      )}
    </section>
  );
}

function currentUsage(status: BillingStatus) {
  const forms = `${status.current.formTemplates} form${status.current.formTemplates === 1 ? "" : "s"}`;
  const members = `${status.current.members} user${status.current.members === 1 ? "" : "s"}`;
  return `${members} · ${forms}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(value));
}

function SettingsLoading() {
  return (
    <div className="emptyState compactEmptyState">
      <div className="emptyGlyph">$</div>
      <h3>Loading billing…</h3>
    </div>
  );
}

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not load billing.";
}
