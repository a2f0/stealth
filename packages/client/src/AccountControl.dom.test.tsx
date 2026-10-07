import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { version as appVersion } from "../package.json";
import { AccountControl } from "./AccountControl";
import { fetchApi } from "./apiVersion";

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

async function respondWith(version: string | null) {
  globalThis.fetch = (async () =>
    Response.json(
      { ok: true },
      { headers: version === null ? {} : { "API-Version": version } },
    )) as unknown as typeof fetch;
  await act(async () => {
    await fetchApi("http://localhost:8787/health");
  });
}

describe("app versions", () => {
  it("shows the app version and the API version its latest response named", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <AccountControl
          accounts={[]}
          activeSessionToken="session"
          loadError={undefined}
          onAddAccount={() => undefined}
          onRefreshAccounts={async () => undefined}
          onSettings={() => undefined}
          onSignOut={async () => undefined}
          onSwitchAccount={async () => undefined}
          user={{ email: "pat@example.com", name: "Pat Person" }}
        />,
      ),
    );
    await respondWith("9.9.1");
    const trigger = container.querySelector<HTMLButtonElement>(
      "button[aria-haspopup]",
    );
    if (!trigger) throw new Error("No account menu trigger.");
    await act(async () => trigger.click());
    const versions = () => container.querySelector(".menuMeta")?.textContent;

    expect(versions()).toBe(`App v${appVersion} · API v9.9.1`);

    await respondWith(null);
    expect(versions()).toBe(`App v${appVersion} · API v9.9.1`);

    await respondWith("9.9.2");
    expect(versions()).toBe(`App v${appVersion} · API v9.9.2`);
  });
});
