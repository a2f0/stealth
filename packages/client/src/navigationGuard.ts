import { dismissDialogs } from "@tearleads/ui/react";
import { useEffect, useRef } from "react";

const positionKey = "workspacePosition";

type NavigationGuard = () => boolean | Promise<boolean>;
const guards = new Set<NavigationGuard>();
let pendingCheck: Promise<boolean> | undefined;

/** Guards session changes before their API calls can replace the workspace. */
export function guardWorkspaceChange<Args extends unknown[]>(
  action: (...args: Args) => Promise<void>,
) {
  return async (...args: Args) => {
    if (await canNavigate()) await action(...args);
  };
}

export function useWorkspaceNavigation(
  onNavigated: (pathname: string) => void,
) {
  const controller = useRef<ReturnType<
    typeof createWorkspaceNavigation
  > | null>(null);
  useEffect(() => {
    const navigation = createWorkspaceNavigation(window, (pathname) => {
      // A question the previous page asked has no page left to act on.
      dismissDialogs();
      onNavigated(pathname);
    });
    controller.current = navigation;
    return () => {
      controller.current = null;
      navigation.dispose();
    };
  }, [onNavigated]);
  return (pathname: string) => controller.current?.navigate(pathname);
}

/**
 * Guarded Back/Forward first returns to its history position, then replays
 * the move once the guards allow it, so a canceled move adds no entries.
 */
export function createWorkspaceNavigation(
  browser: Window,
  onNavigated: (pathname: string) => void,
) {
  const { history, location } = browser;
  let position = historyPosition(history.state) ?? 0;
  let restoring = false;
  let asking = false;
  let approved = false;
  let afterRestore: (() => void) | undefined;
  history.replaceState({ ...history.state, [positionKey]: position }, "");
  // Untagged entries precede the first entry owned by the workspace.
  const restore = (next: number | undefined) => {
    restoring = true;
    history.go(next === undefined ? 1 : position - next);
  };
  const arrive = (next: number | undefined) => {
    position = next ?? position - 1;
    if (next === undefined)
      history.replaceState({ ...history.state, [positionKey]: position }, "");
    onNavigated(location.pathname);
  };
  const pop = (event: PopStateEvent) => {
    const next = historyPosition(event.state);
    if (restoring) {
      if (next !== position) {
        history.go(next === undefined ? 1 : position - next);
        return;
      }
      restoring = false;
      const resume = afterRestore;
      afterRestore = undefined;
      resume?.();
      return;
    }
    if (next === position) return;
    if (approved || !navigationGuarded()) {
      approved = false;
      arrive(next);
      return;
    }
    restore(next);
    // A second Back or Forward while the guards ask is simply undone.
    if (asking) return;
    asking = true;
    const replay = next === undefined ? -1 : next - position;
    void canNavigate().then((allowed) => {
      asking = false;
      if (!allowed) return;
      const go = () => {
        approved = true;
        history.go(replay);
      };
      if (restoring) afterRestore = go;
      else go();
    });
  };
  browser.addEventListener("popstate", pop);
  return {
    dispose: () => browser.removeEventListener("popstate", pop),
    navigate: (pathname: string) => {
      if (restoring || asking) return;
      const destination = new URL(pathname, location.origin);
      const origin = location.href;
      if (destination.origin !== location.origin || destination.href === origin)
        return;
      const go = () => {
        position += 1;
        history.pushState(
          { [positionKey]: position },
          "",
          `${destination.pathname}${destination.search}${destination.hash}`,
        );
        onNavigated(destination.pathname);
      };
      if (!navigationGuarded()) {
        go();
        return;
      }
      asking = true;
      void canNavigate().then((allowed) => {
        asking = false;
        if (!allowed) return;
        // Never push over a location that changed while the guards asked.
        const proceed = () => {
          if (location.href === origin) go();
        };
        if (restoring) afterRestore = proceed;
        else proceed();
      });
    },
  };
}

function historyPosition(state: unknown) {
  if (!state || typeof state !== "object") return undefined;
  const position = Reflect.get(state, positionKey);
  return typeof position === "number" && Number.isSafeInteger(position)
    ? position
    : undefined;
}

/** Lets an editor with explicit saves stop navigation away from its work. */
export function addNavigationGuard(guard: NavigationGuard) {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}

function navigationGuarded() {
  return guards.size > 0;
}

/**
 * Asks each guard in turn whether the workspace may navigate. Overlapping
 * requests share one answer, so they never stack a second dialog.
 */
export function canNavigate() {
  if (!pendingCheck) {
    const check = askGuards();
    const settle = () => {
      if (pendingCheck === check) pendingCheck = undefined;
    };
    pendingCheck = check;
    check.then(settle, settle);
  }
  return pendingCheck;
}

async function askGuards() {
  for (const guard of [...guards]) {
    if (!(await guard())) return false;
  }
  return true;
}
