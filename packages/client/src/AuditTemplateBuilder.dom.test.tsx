import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { AuditTemplate } from "./auditApi";

const dom = new Window({ url: "http://localhost:5173/audits/templates/t1" });
const domGlobals = {
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  document: dom.document,
  Element: dom.Element,
  HTMLElement: dom.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  navigator: dom.navigator,
  Node: dom.Node,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  window: dom,
};
const saved = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;
let createRoot: (container: Element) => Root;
let AuditTemplateBuilder: typeof import("./AuditTemplateBuilder").AuditTemplateBuilder;
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
  ({ AuditTemplateBuilder } = await import("./AuditTemplateBuilder"));
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

function question(id: string, prompt: string) {
  return { id, prompt, required: true, responseType: "check" as const };
}

const template: AuditTemplate = {
  createdAt: "2026-10-01T09:00:00.000Z",
  currentVersion: 1,
  definition: {
    sections: [
      {
        id: "s1",
        items: [
          question("q1", "First"),
          question("q2", "Second"),
          question("q3", "Third"),
        ],
        title: "Kitchen",
      },
      { id: "s2", items: [question("q4", "Other")], title: "Storage" },
    ],
    version: 1,
  },
  description: "",
  id: "t1",
  name: "Opening checklist",
  savedAt: "2026-10-01T09:00:00.000Z",
  savedBy: { email: "olivia@example.com", id: "u1", name: "Olivia" },
  scope: "organization",
  status: "draft",
  updatedAt: "2026-10-01T09:00:00.000Z",
  version: 1,
};

/** Serves the template; a save echoes back what was sent. */
function stubApi() {
  const saves: Array<{ definition: AuditTemplate["definition"] }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as {
        definition: AuditTemplate["definition"];
      };
      saves.push(body);
      return Response.json({
        template: { ...template, ...body, currentVersion: 2, version: 2 },
      });
    }
    if (url.pathname.endsWith("/templates/t1")) {
      return Response.json({ template });
    }
    if (url.pathname.endsWith("/versions")) {
      return Response.json({ versions: [] });
    }
    return Response.json({ events: [], nextCursor: null });
  }) as typeof fetch;
  return saves;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

async function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(<AuditTemplateBuilder id="t1" onNavigate={() => {}} />),
  );
  await settle();
}

const sections = () => [
  ...container.querySelectorAll<HTMLElement>(".auditSectionCard"),
];
const sectionTitles = () =>
  sections().map(
    (section) =>
      section.querySelector<HTMLInputElement>(".auditSectionTitle")?.value,
  );
const prompts = (sectionIndex = 0) =>
  [
    ...(sections()[sectionIndex]?.querySelectorAll<HTMLTextAreaElement>(
      ".auditQuestionPrompt",
    ) ?? []),
  ].map((field) => field.value);
const questions = (sectionIndex = 0) => [
  ...(sections()[sectionIndex]?.querySelectorAll<HTMLElement>(
    ".auditQuestion",
  ) ?? []),
];
const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (item) => item.textContent === label,
  );

async function press(element: Element | null | undefined, key: string) {
  await act(async () => {
    element?.dispatchEvent(
      new dom.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key,
      }) as never,
    );
  });
  await settle();
}

async function pointer(
  element: Element | null | undefined,
  type: "pointerdown" | "pointermove" | "pointerup",
  clientY: number,
) {
  await act(async () => {
    element?.dispatchEvent(
      new dom.PointerEvent(type, {
        bubbles: true,
        button: 0,
        cancelable: true,
        clientY,
        pointerId: 1,
      }) as never,
    );
  });
}

describe("reordering the audit form", () => {
  it("moves a question from its number's menu and saves the new order", async () => {
    const saves = stubApi();
    await render();
    const number = sections()[0]?.querySelector<HTMLButtonElement>(
      'button[aria-label="Question 1 order"]',
    );
    await act(async () => number?.click());
    expect(menuItem("Move up")?.disabled).toBe(true);
    expect(menuItem("Move down")?.disabled).toBe(false);

    await act(async () => menuItem("Move down")?.click());
    await settle();
    expect(prompts()).toEqual(["Second", "First", "Third"]);
    expect(document.activeElement?.getAttribute("data-reorder-focus")).toBe(
      "number-q1",
    );
    expect(document.activeElement?.textContent).toBe("2");

    const save = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Save as version 2"),
    );
    await act(async () => save?.click());
    await settle();
    expect(
      saves[0]?.definition.sections[0]?.items.map(({ prompt }) => prompt),
    ).toEqual(["Second", "First", "Third"]);
  });

  it("moves a section with its number's menu and with the arrow keys on its handle", async () => {
    stubApi();
    await render();
    const storage = sections()[1];
    await act(async () =>
      storage
        ?.querySelector<HTMLButtonElement>(
          'button[aria-label="Section 2 order"]',
        )
        ?.click(),
    );
    expect(menuItem("Move down")?.disabled).toBe(true);
    await act(async () => menuItem("Move up")?.click());
    await settle();
    expect(sectionTitles()).toEqual(["Storage", "Kitchen"]);

    const kitchenHandle = sections()[1]?.querySelector<HTMLElement>(
      ".auditSectionHeader .auditDragHandle",
    );
    await press(kitchenHandle, "ArrowUp");
    expect(sectionTitles()).toEqual(["Kitchen", "Storage"]);
    expect(document.activeElement?.getAttribute("data-reorder-focus")).toBe(
      "handle-s1",
    );
    await press(document.activeElement, "ArrowUp");
    expect(sectionTitles()).toEqual(["Kitchen", "Storage"]);
  });

  it("drags a question by its handle, showing where it will land", async () => {
    stubApi();
    await render();
    for (const [index, row] of questions().entries()) {
      row.getBoundingClientRect = () =>
        ({ height: 100, top: index * 100 }) as DOMRect;
    }
    const handle = questions()[0]?.querySelector(".auditDragHandle");
    await pointer(handle, "pointerdown", 50);
    await pointer(handle, "pointermove", 260);

    const [first, , third] = questions();
    expect(first?.className).toContain("auditDragging");
    expect(first?.style.transform).toBe("translateY(210px)");
    expect(third?.className).toContain("auditDropAfter");

    await pointer(handle, "pointerup", 260);
    await settle();
    expect(prompts()).toEqual(["Second", "Third", "First"]);
    expect(container.querySelector(".auditDragging")).toBeNull();
    expect(prompts(1)).toEqual(["Other"]);
  });

  it("keeps scrolling at the edge while the pointer holds still", async () => {
    stubApi();
    await render();
    let scrolled = 0;
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    const replaced = {
      cancelAnimationFrame: (id: number) => frames.delete(id),
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        nextFrame += 1;
        frames.set(nextFrame, callback);
        return nextFrame;
      },
    };
    const saved = new Map(
      Object.keys(replaced).map((key) => [
        key,
        Object.getOwnPropertyDescriptor(globalThis, key),
      ]),
    );
    const savedScroll = ["scrollBy", "scrollY"].map(
      (key) => [key, Object.getOwnPropertyDescriptor(dom, key)] as const,
    );
    // The page can scroll 300px when the drag begins, and no further.
    const page = dom.document.documentElement;
    Object.defineProperty(page, "scrollHeight", {
      configurable: true,
      get: () => dom.innerHeight + 300,
    });
    for (const [key, value] of Object.entries(replaced)) {
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    Object.defineProperty(dom, "scrollBy", {
      configurable: true,
      value: (_x: number, y: number) => {
        scrolled += y;
      },
    });
    Object.defineProperty(dom, "scrollY", {
      configurable: true,
      get: () => scrolled,
    });
    /** Runs `count` animation frames, as the browser would while still. */
    const runFrames = async (count: number) => {
      for (let frame = 0; frame < count; frame += 1) {
        const pending = [...frames.values()];
        frames.clear();
        await act(async () => {
          for (const callback of pending) callback(0);
        });
      }
    };
    try {
      // Tall questions, so reaching the next one needs the page to scroll.
      for (const [index, row] of questions().entries()) {
        row.getBoundingClientRect = () =>
          ({ height: 600, top: index * 600 - scrolled }) as DOMRect;
      }
      const edge = dom.innerHeight - 10;
      const handle = questions()[0]?.querySelector(".auditDragHandle");
      await pointer(handle, "pointerdown", 50);
      await pointer(handle, "pointermove", edge);
      expect(questions()[1]?.className).not.toContain("auditDropAfter");

      await runFrames(12);
      expect(scrolled).toBe(12 * 16);
      expect(questions()[1]?.className).toContain("auditDropAfter");

      // It stops at the end of the page as it was, however long it waits.
      await runFrames(30);
      expect(scrolled).toBe(300);

      // Dropping stops the scrolling; the next frames only restore focus.
      await pointer(handle, "pointerup", edge);
      await runFrames(3);
      expect(scrolled).toBe(300);
      expect(prompts()).toEqual(["Second", "First", "Third"]);
    } finally {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      for (const [key, descriptor] of savedScroll) {
        if (descriptor) Object.defineProperty(dom, key, descriptor);
        else Reflect.deleteProperty(dom, key);
      }
      Reflect.deleteProperty(page, "scrollHeight");
    }
  });
});
