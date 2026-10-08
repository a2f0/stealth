import type { Stripe, StripeCheckoutSession } from "@stripe/stripe-js";
import type { InlineCheckoutSession } from "./billingApi";
import { readCheckoutAppearance } from "./checkoutAppearance";

export interface CheckoutSummary {
  dueToday: string;
  interval: string | null;
}

export interface MountedCheckout {
  /** Resolves with an error message; success leaves the page. */
  confirm: () => Promise<string | null>;
}

type LoadStripe = (publishableKey: string) => Promise<Stripe | null>;

/** The iframe cannot use the app's bundled font, so it loads its own copy. */
const checkoutFonts = [
  {
    cssSrc:
      "https://fonts.googleapis.com/css2?family=Manrope:wght@400..700&display=swap",
  },
];

/**
 * Mounts Stripe's Payment Element for an inline Checkout Session in `host`
 * until `signal` aborts. Stripe.js loads only when Checkout opens, and a mount
 * aborted while it loads never reaches Stripe. On a successful confirmation,
 * Stripe sends the browser to the session's return URL, where the billing page
 * confirms the subscription exactly as it does after hosted Checkout.
 */
export async function mountCheckout(
  host: HTMLElement,
  session: InlineCheckoutSession,
  onChange: (summary: CheckoutSummary) => void,
  signal: AbortSignal,
  load: LoadStripe = loadStripeJs,
): Promise<MountedCheckout> {
  const stripe = await load(session.publishableKey);
  signal.throwIfAborted();
  if (!stripe) throw new Error("Stripe could not be loaded.");
  const checkout = stripe.initCheckoutElementsSdk({
    clientSecret: session.clientSecret,
    elementsOptions: {
      appearance: readCheckoutAppearance(host),
      fonts: checkoutFonts,
    },
  });
  checkout.on("change", (current) => onChange(summarize(current)));
  const paymentElement = checkout.createPaymentElement({ layout: "tabs" });
  paymentElement.mount(host);
  const themeObserver = new MutationObserver(() =>
    checkout.changeAppearance(readCheckoutAppearance(host)),
  );
  themeObserver.observe(host.ownerDocument.documentElement, {
    attributeFilter: ["data-theme"],
  });
  const teardown = () => {
    themeObserver.disconnect();
    paymentElement.destroy();
  };
  signal.addEventListener("abort", teardown, { once: true });
  const loaded = await checkout.loadActions();
  signal.throwIfAborted();
  if (loaded.type === "error") {
    signal.removeEventListener("abort", teardown);
    teardown();
    throw new Error(loaded.error.message);
  }
  const { actions } = loaded;
  onChange(summarize(actions.getSession()));
  return {
    async confirm() {
      const result = await actions.confirm();
      return result.type === "error" ? result.error.message : null;
    },
  };
}

async function loadStripeJs(publishableKey: string) {
  const { loadStripe } = await import("@stripe/stripe-js/pure");
  return loadStripe(publishableKey);
}

function summarize(session: StripeCheckoutSession): CheckoutSummary {
  return {
    dueToday: session.total.total.amount,
    interval: session.recurring?.interval ?? null,
  };
}
