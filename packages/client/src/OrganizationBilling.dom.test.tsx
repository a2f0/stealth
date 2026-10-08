import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  mock,
} from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { BillingStatus } from "./billingApi";

const dom = new Window({ url: "http://localhost:5173/organization/billing" });
const domGlobals = {
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  MutationObserver: dom.MutationObserver,
  navigator: dom.navigator,
  Node: dom.Node,
  window: dom,
};
const saved = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;
// A stand-in for Stripe.js, so the page runs the real adapter end to end.
const stripe = {
  confirmResult: { type: "success" } as object,
  confirmed: 0,
  destroyed: 0,
  initialized: [] as string[],
  mounted: [] as Element[],
  releaseActions: () => {},
};
let createRoot: (container: Element) => Root;
let OrganizationBilling: typeof import("./OrganizationBilling").OrganizationBilling;
let root: Root | undefined;
let container: HTMLElement;

mock.module("@stripe/stripe-js/pure", () => ({
  loadStripe: async (publishableKey: string) => ({
    initCheckoutElementsSdk: ({ clientSecret }: { clientSecret: string }) => {
      stripe.initialized.push(`${publishableKey} ${clientSecret}`);
      const actionsReady = new Promise<void>((resolve) => {
        stripe.releaseActions = resolve;
      });
      return {
        changeAppearance: () => {},
        createPaymentElement: () => ({
          destroy: () => {
            stripe.destroyed += 1;
          },
          mount: (element: Element) => stripe.mounted.push(element),
        }),
        loadActions: async () => {
          await actionsReady;
          return {
            actions: {
              confirm: async () => {
                stripe.confirmed += 1;
                return stripe.confirmResult;
              },
              getSession: () => ({
                recurring: { interval: "month" },
                total: { total: { amount: "$10.00" } },
              }),
            },
            type: "success",
          };
        },
        on: () => {},
      };
    },
  }),
}));

beforeAll(async () => {
  for (const [key, value] of Object.entries(domGlobals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
  ({ createRoot } = await import("react-dom/client"));
  ({ OrganizationBilling } = await import("./OrganizationBilling"));
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  globalThis.fetch = originalFetch;
  Object.assign(stripe, {
    confirmResult: { type: "success" },
    confirmed: 0,
    destroyed: 0,
    initialized: [],
    mounted: [],
  });
});

afterAll(async () => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});

const freeStatus: BillingStatus = {
  billing: { cancelAtPeriodEnd: false, currentPeriodEnd: null, status: null },
  canManage: true,
  current: { formTemplates: 1, members: 1 },
  limits: { formTemplates: 5, retentionDays: 30, users: 1 },
  plan: "free",
  pricing: { currency: "usd", proMonthlyPerSeat: 1_000 },
  seats: 1,
};

function serveBilling(checkout: unknown, status: BillingStatus = freeStatus) {
  const requests: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requests.push(`${init?.method ?? "GET"} ${url.replace(/^.*\/api/, "")}`);
    return Response.json(url.endsWith("/checkout") ? checkout : status);
  }) as typeof fetch;
  return requests;
}

/** Lets the adapter's chain of loads settle. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

let planChanges = 0;

async function render() {
  planChanges = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <OrganizationBilling
        onPlanChanged={async () => {
          planChanges += 1;
        }}
        organizationId="org-1"
      />,
    ),
  );
}

function button(text: string) {
  const found = [...container.querySelectorAll("button")].find((element) =>
    element.textContent?.includes(text),
  );
  if (!found) throw new Error(`No button labeled ${text}`);
  return found;
}

async function click(text: string) {
  await act(async () => button(text).click());
}

describe("organization billing checkout", () => {
  it("embeds inline Checkout in place of the plans", async () => {
    const requests = serveBilling({
      clientSecret: "cs_secret",
      publishableKey: "pk_test",
    });
    await render();
    await click("Upgrade to Pro");
    await settle();

    expect(requests).toEqual(["GET /billing", "POST /billing/checkout"]);
    expect(stripe.initialized).toEqual(["pk_test cs_secret"]);
    expect(stripe.mounted.map((element) => element.className)).toEqual([
      "billingCheckoutPayment",
    ]);
    expect(container.querySelector(".billingPlans")).toBeNull();
    expect(button("Subscribe").disabled).toBe(true);

    stripe.releaseActions();
    await settle();
    expect(container.textContent).toContain(
      "$10.00 due today. Renews every month.",
    );
    expect(button("Subscribe").disabled).toBe(false);

    stripe.confirmResult = {
      error: { message: "Your card was declined." },
      type: "error",
    };
    await click("Subscribe");
    expect(stripe.confirmed).toBe(1);
    expect(container.querySelector(".bannerDanger")?.textContent).toContain(
      "Your card was declined.",
    );
    expect(button("Subscribe").disabled).toBe(false);

    await click("Cancel");
    expect(stripe.destroyed).toBe(1);
    expect(container.querySelector(".billingCheckoutPayment")).toBeNull();
    expect(button("Upgrade to Pro")).toBeDefined();
  });

  it("keeps the form busy after a successful confirmation", async () => {
    serveBilling({ clientSecret: "cs_secret", publishableKey: "pk_test" });
    await render();
    await click("Upgrade to Pro");
    await settle();
    stripe.releaseActions();
    await settle();

    await click("Subscribe");
    expect(stripe.confirmed).toBe(1);
    expect(button("Subscribing").getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector(".bannerDanger")).toBeNull();
  });

  it("reports a return without payment and clears the query", async () => {
    dom.history.replaceState(
      null,
      "",
      "/organization/billing?checkout=success&session_id=cs_open",
    );
    const requests = serveBilling(null, {
      ...freeStatus,
      checkout: "incomplete",
    });
    await render();

    expect(requests).toEqual(["GET /billing?session_id=cs_open"]);
    expect(container.querySelector(".banner")?.textContent).toContain(
      "Payment was not completed. Your plan has not changed.",
    );
    expect(container.querySelector(".bannerSuccess")).toBeNull();
    expect(dom.location.search).toBe("");
    expect(planChanges).toBe(0);
  });

  it("refreshes workspace access after a completed Checkout", async () => {
    dom.history.replaceState(
      null,
      "",
      "/organization/billing?checkout=success&session_id=cs_paid",
    );
    serveBilling(null, { ...freeStatus, checkout: "complete", plan: "pro" });
    await render();

    expect(container.querySelector(".bannerSuccess")?.textContent).toContain(
      "Your Pro subscription is active.",
    );
    expect(planChanges).toBe(1);
    expect(dom.location.search).toBe("");
  });

  it("opens hosted Checkout when the API returns a URL", async () => {
    const navigations: string[] = [];
    const location = dom.location as unknown as {
      assign: (url: string) => void;
    };
    const originalAssign = location.assign;
    location.assign = (url: string) => navigations.push(url);
    try {
      serveBilling({ url: "https://checkout.stripe.test/hosted" });
      await render();
      await click("Upgrade to Pro");
      expect(navigations).toEqual(["https://checkout.stripe.test/hosted"]);
      expect(stripe.initialized).toHaveLength(0);
    } finally {
      location.assign = originalAssign;
    }
  });
});
