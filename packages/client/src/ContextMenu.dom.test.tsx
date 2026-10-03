import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { ContextMenu } from "@tearleads/ui/react";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

const dom = new Window({ url: "http://localhost:5173" });
const saved = new Map<string, PropertyDescriptor | undefined>();
let createRoot: (container: Element) => Root;
let root: Root | undefined;
let container: HTMLElement;

beforeAll(async () => {
  for (const [key, value] of Object.entries({
    document: dom.document,
    Element: dom.Element,
    HTMLElement: dom.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    Node: dom.Node,
    window: dom,
  })) {
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

async function mount() {
  const selected: string[] = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <>
        <ContextMenu
          label="Record actions"
          items={[
            {
              id: "first",
              label: "First",
              onSelect: () => {
                selected.push("first");
              },
            },
            {
              disabled: true,
              id: "disabled",
              label: "Disabled",
              onSelect: () => {
                selected.push("disabled");
              },
            },
            {
              id: "last",
              label: "Last",
              onSelect: () => {
                selected.push("last");
              },
            },
          ]}
        >
          {(props) => (
            <section {...props}>
              <a href="/record">Record</a>
              <button type="button">
                Control
                <svg aria-hidden="true">
                  <path d="M0 0h10v10" />
                </svg>
              </button>
              <input aria-label="Name" />
            </section>
          )}
        </ContextMenu>
        <button className="outsideControl" type="button">
          Outside
        </button>
      </>,
    ),
  );
  return {
    input: container.querySelector<HTMLInputElement>("input"),
    link: container.querySelector<HTMLAnchorElement>("a"),
    control: container.querySelector<HTMLButtonElement>("section button"),
    icon: container.querySelector<SVGElement>("svg path"),
    outside: container.querySelector<HTMLButtonElement>(".outsideControl"),
    selected,
  };
}

const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
const items = () => [
  ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
];

async function contextClick(element: Element | null, x = 120, y = 180) {
  const event = new dom.MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: x,
    clientY: y,
  });
  await act(async () => element?.dispatchEvent(event as never));
  return event;
}

async function key(element: Element | null, value: string, shiftKey = false) {
  const event = new dom.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: value,
    shiftKey,
  });
  await act(async () => element?.dispatchEvent(event as never));
  return event;
}

describe("shared context menu", () => {
  it("restores focus to the control when opened from its SVG icon", async () => {
    const view = await mount();
    await contextClick(view.icon);
    expect(menu()).not.toBeNull();
    await key(document.activeElement, "Escape");
    expect(document.activeElement).toBe(view.control);
  });
  it("opens at the pointer in a portal and focuses the first action", async () => {
    const view = await mount();
    const event = await contextClick(view.link);
    expect(event.defaultPrevented).toBe(true);
    expect(menu()?.parentElement).toBe(document.body);
    expect(menu()?.style.left).toBe("120px");
    expect(menu()?.style.top).toBe("180px");
    expect(document.activeElement).toBe(items()[0] ?? null);
  });

  it("opens with Shift+F10 or the menu key, navigates enabled actions, and restores focus", async () => {
    const view = await mount();
    view.link?.focus();
    expect((await key(view.link, "F10", true)).defaultPrevented).toBe(true);
    await key(document.activeElement, "ArrowDown");
    expect(document.activeElement).toBe(items()[2] ?? null);
    await key(document.activeElement, "ArrowDown");
    expect(document.activeElement).toBe(items()[0] ?? null);
    await key(document.activeElement, "ArrowUp");
    expect(document.activeElement).toBe(items()[2] ?? null);
    await key(document.activeElement, "Home");
    expect(document.activeElement).toBe(items()[0] ?? null);
    await key(document.activeElement, "End");
    expect(document.activeElement).toBe(items()[2] ?? null);
    await act(async () => (document.activeElement as HTMLElement).click());
    expect(view.selected).toEqual(["last"]);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(view.link);
    await key(view.link, "ContextMenu");
    expect(menu()).not.toBeNull();
    expect((await key(document.activeElement, "Escape")).defaultPrevented).toBe(
      true,
    );
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(view.link);
  });

  it("dismisses on outside press, focus, scrolling, resize, and window blur", async () => {
    const view = await mount();
    for (const event of [
      "pointerdown",
      "focusin",
      "scroll",
      "resize",
      "blur",
    ]) {
      await contextClick(view.link);
      await act(async () => {
        if (event === "pointerdown")
          view.outside?.dispatchEvent(
            new dom.PointerEvent(event, { bubbles: true }) as never,
          );
        else if (event === "focusin") view.outside?.focus();
        else window.dispatchEvent(new dom.Event(event) as never);
      });
      expect(menu()).toBeNull();
    }
    expect(view.selected).toEqual([]);
  });

  it("dismisses on Tab while allowing normal keyboard navigation", async () => {
    const view = await mount();
    await contextClick(view.link);
    expect((await key(document.activeElement, "Tab")).defaultPrevented).toBe(
      false,
    );
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(view.link);
  });

  it("keeps the native menu on editable fields", async () => {
    const view = await mount();
    expect((await contextClick(view.input)).defaultPrevented).toBe(false);
    expect((await key(view.input, "F10", true)).defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
  });

  it("keeps the menu inside the viewport near its bottom-right edge", async () => {
    const view = await mount();
    const original = dom.HTMLElement.prototype.getBoundingClientRect;
    dom.HTMLElement.prototype.getBoundingClientRect = function () {
      return this.classList.contains("contextMenu")
        ? new dom.DOMRect(0, 0, 200, 120)
        : original.call(this);
    };
    try {
      await contextClick(
        view.link,
        window.innerWidth - 1,
        window.innerHeight - 1,
      );
      expect(menu()?.style.left).toBe(`${window.innerWidth - 208}px`);
      expect(menu()?.style.top).toBe(`${window.innerHeight - 128}px`);
    } finally {
      dom.HTMLElement.prototype.getBoundingClientRect = original;
    }
  });

  it("removes an open portal when its target unmounts", async () => {
    const view = await mount();
    await contextClick(view.link);
    await act(async () => root?.unmount());
    root = undefined;
    expect(menu()).toBeNull();
  });
});
