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
import type { BillingStatus, InlineCheckoutSession } from "./billingApi";
import type { CheckoutSummary } from "./stripeCheckout";

const dom = new Window({ url: "http://localhost:5173/organization/billing" });
const domGlobals = {
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  navigator: dom.navigator,
  Node: dom.Node,
  window: dom,
};
const saved = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;
const mounts: Array<{
  host: HTMLElement;
  onChange: (summary: CheckoutSummary) => void;
  session: InlineCheckoutSession;
}> = [];
const confirmations: string[] = [];
let confirmResult: string | null = null;
let destroyed = 0;
let createRoot: (container: Element) => Root;
let OrganizationBilling: typeof import("./OrganizationBilling").OrganizationBilling;
let root: Root | undefined;
let container: HTMLElement;

mock.module("./stripeCheckout", () => ({
  mountCheckout: async (
    host: HTMLElement,
    session: InlineCheckoutSession,
    onChange: (summary: CheckoutSummary) => void,
    signal: AbortSignal,
  ) => {
    mounts.push({ host, onChange, session });
    signal.addEventListener("abort", () => {
      destroyed += 1;
    });
    return {
      confirm: async () => {
        confirmations.push(session.clientSecret);
        return confirmResult;
      },
    };
  },
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
  mounts.length = 0;
  confirmations.length = 0;
  confirmResult = null;
  destroyed = 0;
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

function serveBilling(checkout: unknown) {
  const requests: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requests.push(`${init?.method ?? "GET"} ${url.replace(/^.*\/api/, "")}`);
    return Response.json(url.endsWith("/checkout") ? checkout : freeStatus);
  }) as typeof fetch;
  return requests;
}

async function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(<OrganizationBilling organizationId="org-1" />),
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
    const session = { clientSecret: "cs_secret", publishableKey: "pk_test" };
    const requests = serveBilling(session);
    await render();
    await click("Upgrade to Pro");

    expect(requests).toEqual(["GET /billing", "POST /billing/checkout"]);
    expect(mounts).toHaveLength(1);
    expect(mounts[0]?.session).toEqual(session);
    expect(mounts[0]?.host.className).toBe("billingCheckoutPayment");
    expect(container.querySelector(".billingPlans")).toBeNull();
    expect(button("Subscribe").disabled).toBe(true);

    await act(async () =>
      mounts[0]?.onChange({ dueToday: "$10.00", interval: "month" }),
    );
    expect(container.textContent).toContain(
      "$10.00 due today. Renews every month.",
    );
    expect(button("Subscribe").disabled).toBe(false);

    confirmResult = "Your card was declined.";
    await click("Subscribe");
    expect(confirmations).toEqual(["cs_secret"]);
    expect(container.querySelector(".bannerDanger")?.textContent).toContain(
      "Your card was declined.",
    );
    expect(button("Subscribe").disabled).toBe(false);

    await click("Cancel");
    expect(destroyed).toBe(1);
    expect(container.querySelector(".billingCheckoutPayment")).toBeNull();
    expect(button("Upgrade to Pro")).toBeDefined();
  });

  it("keeps the form busy after a successful confirmation", async () => {
    serveBilling({ clientSecret: "cs_secret", publishableKey: "pk_test" });
    await render();
    await click("Upgrade to Pro");
    await act(async () =>
      mounts[0]?.onChange({ dueToday: "$10.00", interval: null }),
    );
    expect(container.textContent).toContain("$10.00 due today.");

    await click("Subscribe");
    expect(confirmations).toEqual(["cs_secret"]);
    expect(button("Subscribing").getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector(".bannerDanger")).toBeNull();
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
      expect(mounts).toHaveLength(0);
    } finally {
      location.assign = originalAssign;
    }
  });
});
