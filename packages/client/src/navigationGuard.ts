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

/**
 * Answers open dialogs with no when `identity` (the signed-in account and its
 * active organization) changes: a question asked for one workspace must never
 * be answered for another.
 */
export function useDismissDialogsOnChange(identity: string) {
  const previous = useRef(identity);
  useEffect(() => {
    if (previous.current === identity) return;
    previous.current = identity;
    dismissDialogs();
  }, [identity]);
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
  // While an allowed move replays: how many entries back it lands.
  let approved: number | undefined;
  let afterRestore: (() => void) | undefined;
  // How far the restore in progress has had to come back so far.
  let restored = { steps: 0 };
  history.replaceState({ ...history.state, [positionKey]: position }, "");
  // Untagged entries precede the first entry owned by the workspace.
  const step = (next: number | undefined) => {
    const delta = next === undefined ? 1 : position - next;
    restored.steps += delta;
    history.go(delta);
  };
  const restore = (next: number | undefined) => {
    restoring = true;
    restored = { steps: 0 };
    step(next);
    return restored;
  };
  const arrive = (next: number | undefined, distance = 1) => {
    position = next ?? position - distance;
    if (next === undefined)
      history.replaceState({ ...history.state, [positionKey]: position }, "");
    onNavigated(location.pathname);
  };
  /** Runs `action` once the guards allow it and any restore has landed. */
  const askThen = (action: () => void) => {
    asking = true;
    void canNavigate().then((allowed) => {
      asking = false;
      if (!allowed) return;
      if (restoring) afterRestore = action;
      else action();
    });
  };
  const pop = (event: PopStateEvent) => {
    const next = historyPosition(event.state);
    if (restoring) {
      if (next !== position) {
        step(next);
        return;
      }
      restoring = false;
      const resume = afterRestore;
      afterRestore = undefined;
      resume?.();
      return;
    }
    if (next === position) return;
    if (approved !== undefined || !navigationGuarded()) {
      const distance = approved;
      approved = undefined;
      arrive(next, distance);
      return;
    }
    const move = restore(next);
    // A second Back or Forward while the guards ask is simply undone.
    if (asking) return;
    // Replay exactly as far as the restore had to come back.
    askThen(() => {
      approved = move.steps;
      history.go(-move.steps);
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
      // Never push over a location that changed while the guards asked.
      askThen(() => {
        if (location.href === origin) go();
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
