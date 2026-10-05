import { afterEach, describe, expect, it } from "bun:test";
import {
  addNavigationGuard,
  createWorkspaceNavigation,
} from "./navigationGuard";

/**
 * Just enough of a browser for the workspace's history handling. Like a real
 * one, `history.go` moves later and then fires popstate.
 */
function fakeBrowser(earlier: string[] = []) {
  const origin = "https://app.test";
  // Earlier entries were not created by the workspace, so they carry no state.
  const entries: { path: string; state: unknown }[] = [
    ...earlier.map((path) => ({ path, state: null })),
    { path: "/", state: null },
  ];
  let index = entries.length - 1;
  const listeners = new Set<(event: PopStateEvent) => void>();
  const current = () => entries[index] as { path: string; state: unknown };
  const browser = {
    addEventListener: (
      _type: string,
      listener: (event: PopStateEvent) => void,
    ) => listeners.add(listener),
    history: {
      get length() {
        return entries.length;
      },
      get state() {
        return current().state;
      },
      go(delta: number) {
        const target = index + delta;
        if (target < 0 || target >= entries.length) return;
        setTimeout(() => {
          index = target;
          for (const listener of listeners) {
            listener({ state: current().state } as PopStateEvent);
          }
        }, 0);
      },
      pushState(state: unknown, _title: string, path: string) {
        entries.splice(index + 1);
        entries.push({ path, state });
        index += 1;
      },
      replaceState(state: unknown) {
        entries[index] = { ...current(), state };
      },
    },
    location: {
      get href() {
        return `${origin}${current().path}`;
      },
      origin,
      get pathname() {
        return current().path;
      },
    },
    removeEventListener: (
      _type: string,
      listener: (event: PopStateEvent) => void,
    ) => listeners.delete(listener),
  };
  return browser as unknown as Window;
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const removals: (() => void)[] = [];

afterEach(() => {
  for (const remove of removals.splice(0)) remove();
});

describe("workspace navigation", () => {
  it("follows a link approved while a Back is still being undone", async () => {
    const browser = fakeBrowser();
    const pages: string[] = [];
    const navigation = createWorkspaceNavigation(browser, (path) =>
      pages.push(path),
    );
    navigation.navigate("/activity");
    navigation.navigate("/contracts/templates/t1");

    let answer: (allowed: boolean) => void = () => {};
    removals.push(
      addNavigationGuard(
        () =>
          new Promise<boolean>((resolve) => {
            answer = resolve;
          }),
      ),
    );
    navigation.navigate("/library");
    // Back while the guard asks; once handled, the workspace starts undoing it.
    browser.history.go(-1);
    await nextTask();
    // The link is approved before that undo lands.
    answer(true);
    await settle();

    expect(browser.location.pathname).toBe("/library");
    expect(pages).toEqual(["/activity", "/contracts/templates/t1", "/library"]);
    expect(browser.history.length).toBe(4);
    navigation.dispose();
  });

  it("replays a guarded multi-entry Back onto the entry chosen", async () => {
    const browser = fakeBrowser(["/welcome"]);
    const pages: string[] = [];
    const navigation = createWorkspaceNavigation(browser, (path) =>
      pages.push(path),
    );
    navigation.navigate("/activity");
    navigation.navigate("/contracts/templates/t1");
    removals.push(addNavigationGuard(async () => true));

    // Back three entries at once, past the workspace's first entry.
    browser.history.go(-3);
    await settle();
    await settle();
    expect(browser.location.pathname).toBe("/welcome");
    expect(pages.at(-1)).toBe("/welcome");

    // The workspace knows where it is: Forward lands on its first entry.
    browser.history.go(1);
    await settle();
    await settle();
    expect(browser.location.pathname).toBe("/");
    expect(pages.at(-1)).toBe("/");
    navigation.dispose();
  });

  it("stays put when the guard declines a link", async () => {
    const browser = fakeBrowser();
    const pages: string[] = [];
    const navigation = createWorkspaceNavigation(browser, (path) =>
      pages.push(path),
    );
    removals.push(addNavigationGuard(() => false));
    navigation.navigate("/library");
    await settle();
    expect(browser.location.pathname).toBe("/");
    expect(pages).toEqual([]);
    navigation.dispose();
  });
});
