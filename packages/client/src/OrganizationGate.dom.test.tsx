import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import type { BillingStatus } from "./billingApi";

const dom = new Window({ url: "http://localhost:5173/" });
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
let createRoot: (container: Element) => Root;
let Workspace: (props: { initialPath: string }) => React.JSX.Element;
let root: Root | undefined;
let container: HTMLElement;

const freeStatus: BillingStatus = {
  billing: { cancelAtPeriodEnd: false, currentPeriodEnd: null, status: null },
  canManage: true,
  current: { formTemplates: 0, members: 2 },
  limits: { formTemplates: 5, retentionDays: 30, users: 1 },
  plan: "free",
  pricing: { currency: "usd", proMonthlyPerSeat: 1_000 },
  seats: 1,
};

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
  const { OrganizationGate } = await import("./OrganizationGate");
  const { OrganizationBilling } = await import("./OrganizationBilling");
  const { useOrganizationAccess } = await import("./useOrganizationAccess");
  // The workspace wiring from App: the real access hook gates each page, and
  // Billing refreshes that access after Checkout, as OrganizationSettings does.
  Workspace = function Workspace({ initialPath }: { initialPath: string }) {
    const [pathname, setPathname] = useState(initialPath);
    const access = useOrganizationAccess("user-1", "org-1");
    if (access.isPending) return <p>Loading workspace</p>;
    return (
      <>
        <nav>
          <button onClick={() => setPathname("/audits")} type="button">
            Audits
          </button>
        </nav>
        <OrganizationGate
          access={access}
          navigate={setPathname}
          pathname={pathname}
          signOut={async () => {}}
        >
          {pathname === "/organization/billing" ? (
            <OrganizationBilling
              onPlanChanged={access.refresh}
              organizationId="org-1"
            />
          ) : (
            <p>Audits page</p>
          )}
        </OrganizationGate>
      </>
    );
  };
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  globalThis.fetch = originalFetch;
  dom.history.replaceState(null, "", "/");
});

afterAll(async () => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});

/** Serves the API; a confirmed Checkout gives the user a seat. */
function serveApi(seatCode: "SEAT_UNAVAILABLE" | "UPGRADE_REQUIRED") {
  const requests: string[] = [];
  let paid = false;
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    requests.push(`${url.pathname}${url.search}`);
    if (url.pathname.endsWith("/organization-groups/access")) {
      return paid
        ? Response.json({
            capabilities: [],
            memberRole: "owner",
            ownerCount: 2,
          })
        : Response.json(
            {
              code: seatCode,
              error: "This organization's Free plan includes one user.",
            },
            { status: 403 },
          );
    }
    if (url.searchParams.get("session_id") === "cs_paid") {
      paid = true;
      return Response.json({
        ...freeStatus,
        checkout: "complete",
        plan: "pro",
      });
    }
    return Response.json(freeStatus);
  }) as typeof fetch;
  return requests;
}

async function render(initialPath: string) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<Workspace initialPath={initialPath} />));
  await settle();
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function link(name: string) {
  return [...container.querySelectorAll("a")].find(
    (element) => element.textContent === name,
  );
}

async function click(element: Element | undefined) {
  if (!element) throw new Error("Nothing to click.");
  await act(async () => {
    element.dispatchEvent(
      new dom.MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
      }) as unknown as Event,
    );
  });
  await settle();
}

describe("organization seat gate", () => {
  it("sends an unseated owner to Billing and lifts the gate after Checkout", async () => {
    const requests = serveApi("UPGRADE_REQUIRED");
    await render("/audits");
    expect(container.textContent).toContain(
      "Upgrade to Pro to restore your access",
    );
    expect(container.textContent).not.toContain("Audits page");

    // Stripe returns here; Billing confirms after access already loaded.
    dom.history.replaceState(
      null,
      "",
      "/audits?checkout=success&session_id=cs_paid",
    );
    await click(link("Go to Billing"));
    expect(container.textContent).toContain("Your Pro subscription is active.");
    expect(requests.filter((path) => path.endsWith("/access"))).toHaveLength(2);

    await click(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Audits",
      ),
    );
    expect(container.textContent).toContain("Audits page");
    expect(container.textContent).not.toContain("Upgrade required");
  });

  it("keeps members without a seat out of Billing too", async () => {
    serveApi("SEAT_UNAVAILABLE");
    await render("/organization/billing");
    expect(container.textContent).toContain("Ask an owner to upgrade to Pro");
    expect(link("Go to Billing")).toBeUndefined();
    expect(container.textContent).not.toContain("Current plan");
  });
});
