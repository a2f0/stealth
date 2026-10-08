import { Banner, Button, Card } from "@tearleads/ui/react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import type { InlineCheckoutSession } from "./billingApi";
import {
  type CheckoutSummary,
  type MountedCheckout,
  mountCheckout,
} from "./stripeCheckout";

/** Stripe's Payment Element for an inline Pro Checkout, styled like the app. */
export function InlineCheckout({
  onCancel,
  session,
}: {
  onCancel: () => void;
  session: InlineCheckoutSession;
}) {
  const host = useRef<HTMLDivElement>(null);
  const checkout = useRef<MountedCheckout | undefined>(undefined);
  const [summary, setSummary] = useState<CheckoutSummary>();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const mounting = new AbortController();
    const { signal } = mounting;
    mountCheckout(
      element,
      session,
      (next) => {
        if (!signal.aborted) setSummary(next);
      },
      signal,
    )
      .then((mounted) => {
        if (!signal.aborted) checkout.current = mounted;
      })
      .catch((cause: unknown) => {
        if (!signal.aborted) setError(messageFrom(cause));
      });
    return () => {
      mounting.abort();
      checkout.current = undefined;
    };
  }, [session]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const mounted = checkout.current;
    if (!mounted || submitting) return;
    setSubmitting(true);
    setError(undefined);
    const failure = await mounted.confirm().catch(messageFrom);
    // Success navigates to the return URL, so only a failure resets the form.
    if (failure !== null) {
      setError(failure);
      setSubmitting(false);
    }
  }

  return (
    <Card
      className="billingCheckout"
      description={
        summary
          ? checkoutDescription(summary)
          : "Enter your payment details to start Pro."
      }
      footer={
        <>
          <Button disabled={submitting} onClick={onCancel} variant="secondary">
            Cancel
          </Button>
          {/* Confirming reports missing details in the form, so only loading disables it. */}
          <Button
            busy={submitting}
            disabled={!summary}
            type="submit"
            variant="primary"
          >
            {submitting ? "Subscribing…" : "Subscribe"}
          </Button>
        </>
      }
      onSubmit={(event) => void submit(event)}
      title="Upgrade to Pro"
    >
      {error && <Banner tone="danger">{error}</Banner>}
      <div className="billingCheckoutPayment" ref={host} />
    </Card>
  );
}

function checkoutDescription(summary: CheckoutSummary) {
  const renewal = summary.interval ? ` Renews every ${summary.interval}.` : "";
  return `${summary.dueToday} due today.${renewal}`;
}

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Checkout failed.";
}
