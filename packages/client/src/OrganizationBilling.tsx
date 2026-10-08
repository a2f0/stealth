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
  type InlineCheckoutSession,
  openCurrentBillingSession,
} from "./billingApi";
import { InlineCheckout } from "./InlineCheckout";
import { countLabel, formatLabel } from "./labels";

type BillingRedirect = "checkout" | "portal";

interface Notice {
  message: string;
  tone: "info" | "success";
}

export function OrganizationBilling({
  onPlanChanged,
  organizationId,
}: {
  /** Called after a completed Checkout, so stale workspace access refreshes. */
  onPlanChanged: () => Promise<void>;
  organizationId: string;
}) {
  const [status, setStatus] = useState<BillingStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<Notice>();
  const [checkout, setCheckout] = useState<InlineCheckoutSession>();
  const loadSequence = useRef(0);
  const actionSequence = useRef(0);
  const planChanged = useRef(onPlanChanged);
  useEffect(() => {
    planChanged.current = onPlanChanged;
  }, [onPlanChanged]);
  const redirect = createBillingAction(actionSequence, {
    setBusy,
    setCheckout,
    setError,
    setNotice,
  });
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setStatus(undefined);
    setError(undefined);
    setNotice(undefined);
    setBusy(false);
    setCheckout(undefined);
    if (!organizationId) return;
    const query = new URLSearchParams(window.location.search);
    const sessionId = query.get("session_id") ?? undefined;
    try {
      const nextStatus = await getBillingStatus(sessionId);
      if (sequence !== loadSequence.current) return;
      setStatus(nextStatus);
      setNotice(checkoutNotice(query, nextStatus));
      clearCheckoutQuery(query);
      // Workspace access loaded before this confirmation and may still say
      // the organization needs an upgrade.
      if (nextStatus.checkout === "complete") void planChanged.current();
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
      {notice && <Banner tone={notice.tone}>{notice.message}</Banner>}
      {status && (
        <>
          <CurrentPlanCard status={status} />
          {checkout ? (
            <InlineCheckout
              key={checkout.clientSecret}
              onCancel={() => setCheckout(undefined)}
              session={checkout}
            />
          ) : (
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
          )}
        </>
      )}
    </>
  );
}

function createBillingAction(
  actionSequence: { current: number },
  {
    setBusy,
    setCheckout,
    setError,
    setNotice,
  }: {
    setBusy: (value: boolean) => void;
    setCheckout: (value: InlineCheckoutSession) => void;
    setError: (value: string | undefined) => void;
    setNotice: (value: Notice | undefined) => void;
  },
) {
  return async (action: BillingRedirect) => {
    const sequence = ++actionSequence.current;
    const isCurrent = () => sequence === actionSequence.current;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      if (action === "portal") {
        await openCurrentBillingSession(createPortalSession, isCurrent, (s) =>
          window.location.assign(s.url),
        );
        return;
      }
      await openCurrentBillingSession(createCheckoutSession, isCurrent, (s) => {
        if ("url" in s) {
          window.location.assign(s.url);
          return;
        }
        setCheckout(s);
        setBusy(false);
      });
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

function checkoutNotice(
  query: URLSearchParams,
  status: BillingStatus,
): Notice | undefined {
  const checkout = query.get("checkout");
  if (checkout === "success" && status.checkout === "incomplete") {
    return {
      message: "Payment was not completed. Your plan has not changed.",
      tone: "info",
    };
  }
  if (checkout === "success") {
    return { message: "Your Pro subscription is active.", tone: "success" };
  }
  if (checkout === "canceled") {
    return {
      message: "Checkout was canceled. Your plan has not changed.",
      tone: "info",
    };
  }
  return undefined;
}

function clearCheckoutQuery(query: URLSearchParams) {
  if (query.has("checkout") || query.has("session_id")) {
    window.history.replaceState(
      window.history.state,
      "",
      "/organization/billing",
    );
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
          {formatLabel(billingStatus)}
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
  return `${countLabel(status.current.members, "user")} · ${countLabel(status.current.formTemplates, "form")}`;
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
