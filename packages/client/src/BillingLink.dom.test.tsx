import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { AuditApiError } from "./auditApi";
import { ErrorBanner, errorNotice } from "./BillingLink";
import {
  blockingSeatRequirement,
  OrganizationSeatRequired,
} from "./OrganizationSeatRequired";

const dom = new Window({ url: "http://localhost:5173/audits" });
const domGlobals = {
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  navigator: dom.navigator,
  Node: dom.Node,
  window: dom,
};
const saved = new Map<string, PropertyDescriptor | undefined>();
let createRoot: (container: Element) => Root;
let root: Root | undefined;
let container: HTMLElement;

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
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
});

afterAll(async () => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});

async function render(element: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(element));
}

function billingLink() {
  return container.querySelector<HTMLAnchorElement>("a");
}

function click(link: HTMLAnchorElement, init: { metaKey?: boolean } = {}) {
  const event = new dom.MouseEvent("click", {
    bubbles: true,
    button: 0,
    cancelable: true,
    ...init,
  });
  link.dispatchEvent(event as unknown as Event);
  return event.defaultPrevented;
}

describe("billing links", () => {
  it("links an upgrade error to Billing without a page load", async () => {
    const paths: string[] = [];
    const limit = new AuditApiError(
      "The Free plan is limited to 5 form templates.",
      new Response(null, { status: 409 }),
      "UPGRADE_REQUIRED",
    );
    await render(
      <ErrorBanner
        error={errorNotice(limit, "fallback")}
        onNavigate={(path) => paths.push(path)}
      />,
    );

    const link = billingLink();
    expect(container.textContent).toContain(limit.message);
    expect(link?.textContent).toBe("Go to Billing");
    expect(link?.getAttribute("href")).toBe("/organization/billing");
    expect(link && click(link)).toBe(true);
    expect(paths).toEqual(["/organization/billing"]);
    expect(link && click(link, { metaKey: true })).toBe(false);
    expect(paths).toHaveLength(1);
  });

  it("leaves other errors without a link", async () => {
    await render(
      <ErrorBanner
        error={errorNotice(new Error("Template not found."), "fallback")}
        onNavigate={() => {}}
      />,
    );
    expect(container.textContent).toContain("Template not found.");
    expect(billingLink()).toBeNull();
    expect(errorNotice("not an error", "fallback")).toEqual({
      message: "fallback",
      upgrade: false,
    });
  });

  it("offers Billing only to owners who can upgrade", async () => {
    const paths: string[] = [];
    await render(
      <OrganizationSeatRequired
        onNavigate={(path) => paths.push(path)}
        requirement="upgrade"
      />,
    );
    expect(container.textContent).toContain("Upgrade to Pro");
    const link = billingLink();
    expect(link && click(link)).toBe(true);
    expect(paths).toEqual(["/organization/billing"]);

    await act(async () =>
      root?.render(
        <OrganizationSeatRequired
          onNavigate={() => {}}
          requirement="ask-owner"
        />,
      ),
    );
    expect(container.textContent).toContain("Ask an owner");
    expect(billingLink()).toBeNull();
  });

  it("keeps Billing reachable only for owners who can upgrade", () => {
    expect(blockingSeatRequirement("upgrade", "/organization/billing")).toBe(
      undefined,
    );
    expect(blockingSeatRequirement("upgrade", "/audits")).toBe("upgrade");
    expect(blockingSeatRequirement("ask-owner", "/organization/billing")).toBe(
      "ask-owner",
    );
    expect(blockingSeatRequirement(undefined, "/audits")).toBeUndefined();
  });
});
