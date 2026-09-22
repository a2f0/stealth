import { type Plan, plans } from "@tearleads/ui/brand";
import {
  Badge,
  type BadgeTone,
  Banner,
  Button,
  Card,
  cx,
  Icon,
  LoadingState,
  PageSection,
} from "@tearleads/ui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type BillingStatus,
  createCheckoutSession,
  createPortalSession,
  getBillingStatus,
  redirectToCurrentBillingSession,
} from "./billingApi";

type BillingRedirect = "checkout" | "portal";

const checkoutCanceledNotice =
  "Checkout was canceled. Your plan has not changed.";

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
    return <LoadingState label="Loading billing…" />;
  }
  return (
    <>
      {error && <Banner tone="danger">{error}</Banner>}
      {notice && (
        <Banner tone={notice === checkoutCanceledNotice ? "info" : "success"}>
          {notice}
        </Banner>
      )}
      {status && (
        <>
          <CurrentPlanCard status={status} />
          <PageSection
            description={
              status.canManage
                ? undefined
                : "An organization owner or admin can change the plan and manage payment details."
            }
            title="Plans"
          >
            <PlanCards
              busy={busy}
              onRedirect={(action) => void redirect(action)}
              status={status}
            />
          </PageSection>
        </>
      )}
    </>
  );
}

function createBillingAction(
  actionSequence: { current: number },
  setBusy: (value: boolean) => void,
  setError: (value: string | undefined) => void,
  setNotice: (value: string | undefined) => void,
) {
  return async (action: BillingRedirect) => {
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
  if (checkout === "canceled") return checkoutCanceledNotice;
  return undefined;
}

function clearCheckoutQuery(query: URLSearchParams) {
  if (query.has("checkout") || query.has("session_id")) {
    window.history.replaceState({}, "", "/organization/billing");
  }
}

function CurrentPlanCard({ status }: { status: BillingStatus }) {
  const billingStatus = status.billing.status ?? status.plan;
  return (
    <Card>
      <div className="billingSummary">
        <div className="billingSummaryHeading">
          <p className="eyebrow">Current plan</p>
          <h2 className="billingSummaryPlan">
            {status.plan === "pro" ? "Pro" : "Free"}
          </h2>
          <p className="billingSummaryUsage">{currentUsage(status)}</p>
        </div>
        <Badge dot tone={statusTone(billingStatus)}>
          {formatStatus(billingStatus)}
        </Badge>
      </div>
      {status.billing.cancelAtPeriodEnd && (
        <Banner announce={false} tone="warning">
          Cancellation is scheduled
          {status.billing.currentPeriodEnd
            ? ` for ${formatDate(status.billing.currentPeriodEnd)}`
            : " for the end of the billing period"}
          .
        </Banner>
      )}
    </Card>
  );
}

function PlanCards({
  busy,
  onRedirect,
  status,
}: {
  busy: boolean;
  onRedirect: (action: BillingRedirect) => void;
  status: BillingStatus;
}) {
  return (
    <div className="gridAuto billingPlans">
      {plans.map((plan) =>
        plan.id === "pro" ? (
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
            key={plan.id}
            onAction={() =>
              onRedirect(status.plan === "pro" ? "portal" : "checkout")
            }
            plan={plan}
          />
        ) : (
          <PlanCard
            action={status.plan === "free" ? "Current plan" : undefined}
            key={plan.id}
            plan={plan}
          />
        ),
      )}
    </div>
  );
}

function PlanCard({
  action,
  busy = false,
  featured = false,
  onAction,
  plan,
}: {
  action?: string | undefined;
  busy?: boolean;
  featured?: boolean;
  onAction?: () => void;
  plan: Plan;
}) {
  return (
    <section className={cx("card billingPlan", featured && "cardAccent")}>
      <div className="billingPlanHeading">
        <h3 className="billingPlanName">{plan.name}</h3>
        <p className="billingPlanDescription">{plan.description}</p>
      </div>
      <p className="billingPrice">
        <span className="billingPriceAmount">{plan.price}</span>
        <span className="billingPriceCadence">{plan.cadence}</span>
      </p>
      <ul className="billingFeatures">
        {plan.features.map((feature) => (
          <li className="billingFeature" key={feature}>
            <Icon name="check" size={16} strokeWidth={2} />
            {feature}
          </li>
        ))}
      </ul>
      {action && (
        <Button
          block
          busy={busy}
          className="billingPlanAction"
          disabled={!onAction}
          onClick={onAction}
          variant={onAction ? "primary" : "secondary"}
        >
          {busy ? "Opening Stripe…" : action}
        </Button>
      )}
    </section>
  );
}

function currentUsage(status: BillingStatus) {
  const forms = `${status.current.formTemplates} form${status.current.formTemplates === 1 ? "" : "s"}`;
  const members = `${status.current.members} user${status.current.members === 1 ? "" : "s"}`;
  return `${members} · ${forms}`;
}

function statusTone(value: string): BadgeTone {
  if (value === "active" || value === "trialing" || value === "pro") {
    return "success";
  }
  if (value === "past_due" || value === "incomplete" || value === "paused") {
    return "warning";
  }
  if (value === "unpaid" || value === "incomplete_expired") return "danger";
  return "neutral";
}

function formatStatus(value: string) {
  const words = value.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(value));
}

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not load billing.";
}
