import { useEffect } from "react";

const navigationEvent = "workspace:navigate";

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
