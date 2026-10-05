import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { DialogHost } from "@tearleads/ui/react";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { AccountSecurity } from "./AccountSecurity";
import { useDismissDialogsOnWorkspaceChange } from "./navigationGuard";

// Mounts the real security page with the app's dialog host, so the
// confirmations guard the actual MFA requests.
const dom = new Window({ url: "http://localhost:5173/account/security" });
const domGlobals = {
  document: dom.document,
  Element: dom.Element,
  HTMLElement: dom.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  navigator: dom.navigator,
  Node: dom.Node,
  window: dom,
};
const saved = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;
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
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});

interface AuthRequest {
  body: unknown;
  path: string;
}

/** Answers the two MFA maintenance endpoints and records every request. */
function stubAuth() {
  const requests: AuthRequest[] = [];
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input instanceof Request ? input.url : input))
      .pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ body, path });
    if (path.endsWith("/two-factor/generate-backup-codes")) {
      return Response.json({
        backupCodes: ["aaaa-bbbb", "cccc-dddd"],
        status: true,
      });
    }
    return Response.json({ status: true });
  }) as typeof fetch;
  return requests;
}

/** Stands in for the app: the signed-in account and its organization. */
function Workspace({ identity }: { identity: string }) {
  const [userId = "", organizationId = ""] = identity.split(":");
  useDismissDialogsOnWorkspaceChange(
    { session: { activeOrganizationId: organizationId }, user: { id: userId } },
    organizationId,
  );
  return null;
}

async function mount(onSecurityChanged: () => Promise<unknown>) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = (identity: string) =>
    act(async () =>
      root?.render(
        <>
          <AccountSecurity
            onSecurityChanged={onSecurityChanged}
            twoFactorEnabled
          />
          <Workspace identity={identity} />
          <DialogHost />
        </>,
      ),
    );
  await render("user-1:org-1");
  return { render };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const card = (title: string) =>
  [...container.querySelectorAll("form")].find((form) =>
    form.textContent?.startsWith(title),
  );
const openDialog = () => document.querySelector("dialog[open]");
const buttonIn = (scope: Element | null | undefined, label: string) =>
  [...(scope?.querySelectorAll("button") ?? [])].find(
    (element) => element.textContent?.trim() === label,
  ) ?? null;

async function click(element: HTMLElement | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => element?.click());
  await settle();
}

/** Fills a card's current-password field and submits the card. */
async function submit(title: string, submitLabel: string) {
  const field = card(title)?.querySelector<HTMLInputElement>(
    'input[type="password"]',
  );
  expect(field).toBeTruthy();
  const setValue = Object.getOwnPropertyDescriptor(
    dom.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setValue?.call(field, "correct horse battery");
    field?.dispatchEvent(new dom.Event("input", { bubbles: true }) as never);
  });
  await click(buttonIn(card(title), submitLabel));
}

describe("recovery code regeneration", () => {
  it("asks first, sends nothing when cancelled, and regenerates once confirmed", async () => {
    const requests = stubAuth();
    await mount(async () => {});

    await submit("Recovery codes", "Generate new codes");
    expect(openDialog()?.textContent).toContain("Generate new recovery codes?");
    await click(buttonIn(openDialog(), "Cancel"));
    expect(requests).toEqual([]);
    expect(container.textContent).not.toContain("aaaa-bbbb");

    await submit("Recovery codes", "Generate new codes");
    await click(buttonIn(openDialog(), "Generate new codes"));
    expect(requests).toEqual([
      {
        body: { password: "correct horse battery" },
        path: "/api/auth/two-factor/generate-backup-codes",
      },
    ]);
    expect(container.textContent).toContain("aaaa-bbbb");
    expect(container.textContent).toContain("New recovery codes generated.");
  });
});

describe("disabling MFA", () => {
  it("asks first, sends nothing when cancelled, and disables once confirmed", async () => {
    const requests = stubAuth();
    let refreshed = 0;
    await mount(async () => {
      refreshed += 1;
    });

    await submit("Disable MFA", "Disable MFA");
    expect(openDialog()?.textContent).toContain("Disable MFA?");
    await click(buttonIn(openDialog(), "Cancel"));
    expect(requests).toEqual([]);
    expect(refreshed).toBe(0);

    await submit("Disable MFA", "Disable MFA");
    await click(buttonIn(openDialog(), "Disable MFA"));
    expect(requests).toEqual([
      {
        body: { password: "correct horse battery" },
        path: "/api/auth/two-factor/disable",
      },
    ]);
    expect(refreshed).toBe(1);
    expect(container.textContent).toContain("MFA disabled.");
  });
});

describe("a workspace change while a security question is open", () => {
  it("answers no, so neither request runs for the account now signed in", async () => {
    const requests = stubAuth();
    const { render } = await mount(async () => {});

    await submit("Disable MFA", "Disable MFA");
    expect(openDialog()).toBeTruthy();
    // Another tab switched accounts underneath the open question.
    await render("user-2:org-1");
    await settle();
    expect(openDialog()).toBeNull();

    await submit("Recovery codes", "Generate new codes");
    expect(openDialog()).toBeTruthy();
    await render("user-2:org-2");
    await settle();
    expect(openDialog()).toBeNull();

    expect(requests).toEqual([]);
    expect(container.textContent).not.toContain("MFA disabled.");
  });
});
