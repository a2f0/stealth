import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { ActivityFeed } from "./ActivityFeed";
import type { ActivityEvent } from "./activityApi";

const dom = new Window({ url: "http://localhost:5173/activity" });
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

async function render(sourceId: string, refreshKey = 0) {
  if (!root) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () =>
    root?.render(
      <ActivityFeed
        refreshKey={refreshKey}
        source={{ id: sourceId, type: "audit_run" }}
      />,
    ),
  );
  await settle();
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === label,
  );
  expect(button).toBeDefined();
  await act(async () => button?.click());
  await settle();
}

function event(id: number, after: string): ActivityEvent {
  return {
    action: "audit.answer_changed",
    actor: { email: "sam@example.com", id: "user-1", name: "Sam" },
    details: {
      after,
      before: "pass",
      prompt: "Exits clear",
      responseType: "check",
    },
    historical: false,
    id,
    occurredAt: "2026-10-02T12:00:00.000Z",
    root: { id: "audit-1", label: "Fire safety", type: "audit_run" },
    subject: { id: "exits", type: "audit_answer" },
  };
}

describe("activity feed, mounted", () => {
  it("loads earlier events, refreshes manually, and reloads after a saved mutation", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input, init) => {
      expect(init?.credentials).toBe("include");
      requests.push(String(input));
      return Response.json(
        requests.length === 2
          ? { events: [event(50, "na")], nextCursor: null }
          : { events: [event(51, "fail")], nextCursor: "51" },
      );
    }) as typeof fetch;
    await render("audit/id");
    expect(container.textContent).toContain("Sam changed an answer");
    expect(container.textContent).toContain("sam@example.com");
    expect(container.textContent).toContain("Exits clear");
    expect(container.textContent).toContain("Fail");
    await click("Load more activity");
    expect(container.querySelectorAll(".activityRow")).toHaveLength(2);
    expect(container.textContent).toContain("N/A");
    expect(requests[1]).toEndWith(
      "/api/audits/runs/audit%2Fid/activity?cursor=51",
    );
    await click("Refresh activity");
    expect(requests).toHaveLength(3);
    expect(container.querySelectorAll(".activityRow")).toHaveLength(1);
    await render("audit/id", 1);
    expect(requests).toHaveLength(4);
  });

  it("ignores a previous audit's response after navigating to another audit", async () => {
    let resolvePrevious: ((response: Response) => void) | undefined;
    globalThis.fetch = (async (input) => {
      if (String(input).includes("/previous/")) {
        return new Promise<Response>((resolve) => {
          resolvePrevious = resolve;
        });
      }
      return Response.json({
        events: [event(5, "Current answer")],
        nextCursor: null,
      });
    }) as typeof fetch;
    await render("previous");
    await render("current");
    await act(async () =>
      resolvePrevious?.(
        Response.json({ events: [event(4, "Stale answer")], nextCursor: null }),
      ),
    );
    await settle();
    expect(container.textContent).toContain("Current answer");
    expect(container.textContent).not.toContain("Stale answer");
  });

  it("lets the user retry when loading activity fails", async () => {
    let requests = 0;
    globalThis.fetch = (async (_input) => {
      requests += 1;
      return requests === 1
        ? Response.json({ error: "Activity unavailable" }, { status: 500 })
        : Response.json({ events: [], nextCursor: null });
    }) as typeof fetch;
    await render("audit-1");
    expect(container.textContent).toContain("Activity unavailable");
    await click("Refresh activity");
    expect(container.textContent).toContain("No activity yet");
    expect(container.textContent).not.toContain("Activity unavailable");
  });
});
