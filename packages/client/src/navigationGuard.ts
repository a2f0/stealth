import { useEffect, useRef } from "react";

const navigationEvent = "workspace:navigate";
const positionKey = "workspacePosition";

/** Guards session changes before their API calls can replace the workspace. */
export function guardWorkspaceChange<Args extends unknown[]>(
  action: (...args: Args) => Promise<void>,
) {
  return async (...args: Args) => {
    if (canNavigate()) await action(...args);
  };
}

export function useWorkspaceNavigation(
  onNavigated: (pathname: string) => void,
) {
  const controller = useRef<ReturnType<
    typeof createWorkspaceNavigation
  > | null>(null);
  useEffect(() => {
    const navigation = createWorkspaceNavigation(window, onNavigated);
    controller.current = navigation;
    return () => {
      controller.current = null;
      navigation.dispose();
    };
  }, [onNavigated]);
  return (pathname: string) => controller.current?.navigate(pathname);
}

/** Canceled Back/Forward returns to its history position without adding entries. */
export function createWorkspaceNavigation(
  browser: Window,
  onNavigated: (pathname: string) => void,
) {
  const { history, location } = browser;
  let position = historyPosition(history.state) ?? 0;
  let restoring = false;
  history.replaceState({ ...history.state, [positionKey]: position }, "");
  const pop = (event: PopStateEvent) => {
    const next = historyPosition(event.state);
    if (restoring) {
      if (next === position) restoring = false;
      else history.go(next === undefined ? 1 : position - next);
      return;
    }
    if (next === position) return;
    if (!canNavigate()) {
      restoring = true;
      // Untagged entries precede the first entry owned by the workspace.
      history.go(next === undefined ? 1 : position - next);
      return;
    }
    position = next ?? position - 1;
    if (next === undefined)
      history.replaceState({ ...history.state, [positionKey]: position }, "");
    onNavigated(location.pathname);
  };
  browser.addEventListener("popstate", pop);
  return {
    dispose: () => browser.removeEventListener("popstate", pop),
    navigate: (pathname: string) => {
      if (restoring) return;
      const destination = new URL(pathname, location.origin);
      if (
        destination.origin !== location.origin ||
        destination.href === location.href ||
        !canNavigate()
      )
        return;
      position += 1;
      history.pushState(
        { [positionKey]: position },
        "",
        `${destination.pathname}${destination.search}${destination.hash}`,
      );
      onNavigated(destination.pathname);
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

/** Allows an editor with explicit saves to protect its unsaved work. */
export function canNavigate() {
  return window.dispatchEvent(
    new window.Event(navigationEvent, { cancelable: true }),
  );
}

export function useUnsavedChanges(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const leave = (event: Event) => {
      if (!window.confirm("Discard your unsaved template changes?"))
        event.preventDefault();
    };
    const close = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener(navigationEvent, leave);
    window.addEventListener("beforeunload", close);
    return () => {
      window.removeEventListener(navigationEvent, leave);
      window.removeEventListener("beforeunload", close);
    };
  }, [dirty]);
}
