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

interface WorkspaceSession {
  session: { activeOrganizationId?: string | null | undefined };
  user: { id: string };
}

/**
 * Answers open dialogs with no when the workspace changes underneath them: a
 * question asked for one account or organization must never be answered for
 * another. The session's active organization is what the API acts on, so it
 * counts even before the organization list catches up with it.
 */
export function useDismissDialogsOnWorkspaceChange(
  session: WorkspaceSession | null | undefined,
  shownOrganizationId: string | undefined,
) {
  useDismissDialogsOnChange(
    [
      session?.user.id,
      session?.session.activeOrganizationId,
      shownOrganizationId,
    ]
      .map((part) => part ?? "")
      .join(":"),
  );
}

function useDismissDialogsOnChange(identity: string) {
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
    const navigation = createWorkspaceNavigation(window, onNavigated);
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
  const workspace = new WorkspaceHistory(browser, onNavigated);
  const pop = (event: PopStateEvent) =>
    workspace.pop(historyPosition(event.state));
  browser.addEventListener("popstate", pop);
  return {
    dispose: () => browser.removeEventListener("popstate", pop),
    navigate: (pathname: string) => workspace.navigate(pathname),
  };
}

class WorkspaceHistory {
  /** While an allowed move replays: how many entries back it lands. */
  #approved: number | undefined;
  #afterRestore: (() => void) | undefined;
  #asking = false;
  readonly #browser: Window;
  /** A navigation the app asked for while the guards were busy. */
  #deferred: string | undefined;
  readonly #onNavigated: (pathname: string) => void;
  #position: number;
  /** How far the restore in progress has had to come back so far. */
  #restored = { steps: 0 };
  #restoring = false;

  constructor(browser: Window, onNavigated: (pathname: string) => void) {
    this.#browser = browser;
    this.#onNavigated = onNavigated;
    const { history } = browser;
    this.#position = historyPosition(history.state) ?? 0;
    history.replaceState(
      { ...history.state, [positionKey]: this.#position },
      "",
    );
  }

  pop(next: number | undefined) {
    if (this.#restoring) {
      this.#continueRestore(next);
      return;
    }
    if (next === this.#position) return;
    if (this.#approved !== undefined || !navigationGuarded()) {
      const distance = this.#approved;
      this.#approved = undefined;
      this.#arrive(next, distance);
      return;
    }
    const move = this.#restore(next);
    // A second Back or Forward while the guards ask is simply undone.
    if (this.#asking) return;
    // Leaving answers whatever the page was asking with no.
    dismissDialogs();
    // Replay exactly as far as the restore had to come back.
    this.#askThen(() => {
      this.#approved = move.steps;
      this.#browser.history.go(-move.steps);
    });
  }

  navigate(pathname: string) {
    // The app moved on while the guards were busy; follow once they finish.
    if (this.#restoring || this.#asking) {
      this.#deferred = pathname;
      return;
    }
    const { location } = this.#browser;
    const destination = new URL(pathname, location.origin);
    const origin = location.href;
    if (destination.origin !== location.origin || destination.href === origin)
      return;
    if (!navigationGuarded()) {
      this.#push(destination);
      return;
    }
    // Never push over a location that changed while the guards asked.
    this.#askThen(() => {
      if (location.href === origin) this.#push(destination);
    });
  }

  /** Runs `action` once the guards allow it and any restore has landed. */
  #askThen(action: () => void) {
    this.#asking = true;
    void canNavigate().then((allowed) => {
      this.#asking = false;
      if (!allowed) {
        this.#followDeferred();
        return;
      }
      // The person chose to leave, so what the app queued meanwhile is moot.
      this.#deferred = undefined;
      if (this.#restoring) this.#afterRestore = action;
      else action();
    });
  }

  #followDeferred() {
    const pathname = this.#deferred;
    if (pathname === undefined || this.#restoring || this.#asking) return;
    this.#deferred = undefined;
    this.navigate(pathname);
  }

  // Untagged entries precede the first entry owned by the workspace.
  #step(next: number | undefined) {
    const delta = next === undefined ? 1 : this.#position - next;
    this.#restored.steps += delta;
    this.#browser.history.go(delta);
  }

  #restore(next: number | undefined) {
    this.#restoring = true;
    this.#restored = { steps: 0 };
    this.#step(next);
    return this.#restored;
  }

  #continueRestore(next: number | undefined) {
    if (next !== this.#position) {
      this.#step(next);
      return;
    }
    this.#restoring = false;
    const resume = this.#afterRestore;
    this.#afterRestore = undefined;
    if (resume) resume();
    else this.#followDeferred();
  }

  #arrive(next: number | undefined, distance = 1) {
    const { history, location } = this.#browser;
    this.#position = next ?? this.#position - distance;
    if (next === undefined)
      history.replaceState(
        { ...history.state, [positionKey]: this.#position },
        "",
      );
    this.#show(location.pathname);
  }

  #push(destination: URL) {
    this.#position += 1;
    this.#browser.history.pushState(
      { [positionKey]: this.#position },
      "",
      `${destination.pathname}${destination.search}${destination.hash}`,
    );
    this.#show(destination.pathname);
  }

  #show(pathname: string) {
    // A question the previous page asked has no page left to act on.
    dismissDialogs();
    this.#onNavigated(pathname);
  }
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
