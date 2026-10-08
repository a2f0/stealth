import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Stripe } from "@stripe/stripe-js";
import { Window } from "happy-dom";
import { type CheckoutSummary, mountCheckout } from "./stripeCheckout";

const dom = new Window();
const savedObserver = Object.getOwnPropertyDescriptor(
  globalThis,
  "MutationObserver",
);
const session = { clientSecret: "cs_secret", publishableKey: "pk_test" };

beforeAll(() => {
  Object.defineProperty(globalThis, "MutationObserver", {
    configurable: true,
    value: dom.MutationObserver,
    writable: true,
  });
});

afterAll(async () => {
  if (savedObserver) {
    Object.defineProperty(globalThis, "MutationObserver", savedObserver);
  } else {
    Reflect.deleteProperty(globalThis, "MutationObserver");
  }
  await dom.happyDOM.close();
});

function host() {
  dom.document.documentElement.setAttribute("data-theme", "light");
  dom.document.body.innerHTML = "<div></div>";
  return dom.document.querySelector("div") as unknown as HTMLElement;
}

function stripeSession(dueToday: string, interval: string | null) {
  return {
    recurring: interval ? { interval } : null,
    total: { total: { amount: dueToday } },
  };
}

function fakeStripe({
  confirm = { type: "success" } as object,
  loadActions,
}: {
  confirm?: object;
  loadActions?: object;
} = {}) {
  const calls = {
    appearances: [] as unknown[],
    destroyed: 0,
    initialized: [] as Array<{ clientSecret: string }>,
    mounted: [] as unknown[],
  };
  let onChange = (_session: unknown) => {};
  const checkout = {
    changeAppearance: (appearance: unknown) =>
      calls.appearances.push(appearance),
    createPaymentElement: () => ({
      destroy: () => {
        calls.destroyed += 1;
      },
      mount: (element: unknown) => calls.mounted.push(element),
    }),
    loadActions: async () =>
      loadActions ?? {
        actions: {
          confirm: async () => confirm,
          getSession: () => stripeSession("$10.00", "month"),
        },
        type: "success",
      },
    on: (_event: string, handler: (current: unknown) => void) => {
      onChange = handler;
    },
  };
  const stripe = {
    initCheckoutElementsSdk: (options: { clientSecret: string }) => {
      calls.initialized.push(options);
      return checkout;
    },
  } as unknown as Stripe;
  return { calls, emit: (current: unknown) => onChange(current), stripe };
}

describe("Stripe inline checkout", () => {
  it("mounts the Payment Element and reports the session", async () => {
    const element = host();
    const fake = fakeStripe({
      confirm: { error: { message: "Your card was declined." }, type: "error" },
    });
    const summaries: CheckoutSummary[] = [];
    const keys: string[] = [];
    const mounted = await mountCheckout(
      element,
      session,
      (summary) => summaries.push(summary),
      new AbortController().signal,
      async (key) => {
        keys.push(key);
        return fake.stripe;
      },
    );

    expect(keys).toEqual(["pk_test"]);
    expect(fake.calls.initialized[0]?.clientSecret).toBe("cs_secret");
    expect(fake.calls.mounted).toEqual([element]);
    expect(summaries).toEqual([{ dueToday: "$10.00", interval: "month" }]);
    fake.emit(stripeSession("$30.00", null));
    expect(summaries.at(-1)).toEqual({ dueToday: "$30.00", interval: null });
    expect(await mounted.confirm()).toBe("Your card was declined.");
  });

  it("resolves a successful confirmation without an error", async () => {
    const fake = fakeStripe();
    const mounted = await mountCheckout(
      host(),
      session,
      () => {},
      new AbortController().signal,
      async () => fake.stripe,
    );
    expect(await mounted.confirm()).toBeNull();
  });

  it("never reaches Stripe when aborted while Stripe.js loads", async () => {
    const fake = fakeStripe();
    let finishLoading = (_stripe: Stripe) => {};
    const loading = new Promise<Stripe>((resolve) => {
      finishLoading = resolve;
    });
    const mounting = new AbortController();
    const result = mountCheckout(
      host(),
      session,
      () => {},
      mounting.signal,
      () => loading,
    );
    mounting.abort();
    finishLoading(fake.stripe);

    await expect(result).rejects.toThrow();
    expect(fake.calls.initialized).toHaveLength(0);
    expect(fake.calls.mounted).toHaveLength(0);
  });

  it("re-themes while mounted and tears down on abort", async () => {
    const fake = fakeStripe();
    const mounting = new AbortController();
    await mountCheckout(
      host(),
      session,
      () => {},
      mounting.signal,
      async () => fake.stripe,
    );

    dom.document.documentElement.setAttribute("data-theme", "dark");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.calls.appearances).toEqual([{ theme: "night" }]);

    mounting.abort();
    expect(fake.calls.destroyed).toBe(1);
    dom.document.documentElement.setAttribute("data-theme", "light");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.calls.appearances).toHaveLength(1);
  });

  it("tears down when Checkout actions fail to load", async () => {
    const fake = fakeStripe({
      loadActions: { error: { message: "Session expired." }, type: "error" },
    });
    const mounting = new AbortController();
    await expect(
      mountCheckout(
        host(),
        session,
        () => {},
        mounting.signal,
        async () => fake.stripe,
      ),
    ).rejects.toThrow("Session expired.");
    expect(fake.calls.destroyed).toBe(1);
    mounting.abort();
    expect(fake.calls.destroyed).toBe(1);
  });

  it("fails when Stripe.js cannot load", async () => {
    await expect(
      mountCheckout(
        host(),
        session,
        () => {},
        new AbortController().signal,
        async () => null,
      ),
    ).rejects.toThrow("Stripe could not be loaded.");
  });
});
