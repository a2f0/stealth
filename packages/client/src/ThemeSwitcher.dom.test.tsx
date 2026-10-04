import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { themeStorageKey } from "./theme";

const dom = new Window({ url: "http://localhost:5173" });
const saved = new Map<string, PropertyDescriptor | undefined>();
let createRoot: (container: Element) => Root;
let ThemeSwitcher: typeof import("./ThemeSwitcher").ThemeSwitcher;
let startThemeSync: typeof import("./theme").startThemeSync;
let stopThemeSync: (() => void) | undefined;
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
  ({ ThemeSwitcher } = await import("./ThemeSwitcher"));
  ({ startThemeSync } = await import("./theme"));
});

afterEach(async () => {
  stopThemeSync?.();
  stopThemeSync = undefined;
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

async function mount(menu = false) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      menu ? (
        <>
          <p id="theme-label">Theme</p>
          <ThemeSwitcher labelledBy="theme-label" menu />
        </>
      ) : (
        <ThemeSwitcher />
      ),
    ),
  );
}

const appliedTheme = () => document.documentElement.getAttribute("data-theme");

function option(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) throw new Error(`No ${label} option.`);
  return button;
}

describe("theme switcher", () => {
  it("applies and remembers the chosen theme", async () => {
    stopThemeSync = startThemeSync();
    await mount();
    expect(option("System").getAttribute("aria-pressed")).toBe("true");
    expect(appliedTheme()).toBe("light");

    await act(async () => option("Dark").click());
    expect(option("Dark").getAttribute("aria-pressed")).toBe("true");
    expect(option("System").getAttribute("aria-pressed")).toBe("false");
    expect(appliedTheme()).toBe("dark");
    expect(dom.localStorage.getItem(themeStorageKey)).toBe("dark");

    await act(async () => option("Light").click());
    expect(appliedTheme()).toBe("light");
  });

  it("renders menu radio items inside a menu", async () => {
    await mount(true);
    const items = container.querySelectorAll('[role="menuitemradio"]');
    expect(items).toHaveLength(3);
    expect(option("Light").getAttribute("aria-checked")).toBe("true");
    expect(option("Light").hasAttribute("aria-pressed")).toBe(false);
    expect(
      container.querySelector("fieldset")?.getAttribute("aria-labelledby"),
    ).toBe("theme-label");
    expect(container.querySelector("legend")).toBeNull();
  });

  it("follows a preference changed in another tab", async () => {
    stopThemeSync = startThemeSync();
    await mount();
    await act(async () => {
      dom.dispatchEvent(
        new dom.StorageEvent("storage", {
          key: themeStorageKey,
          newValue: "dark",
        }) as never,
      );
    });
    expect(option("Dark").getAttribute("aria-pressed")).toBe("true");
    expect(appliedTheme()).toBe("dark");
  });
});
