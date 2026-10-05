import { confirmDialog } from "@tearleads/ui/react";
import { useEffect } from "react";
import { addNavigationGuard } from "./navigationGuard";

export function confirmDiscardChanges() {
  return confirmDialog({
    cancelLabel: "Keep editing",
    confirmLabel: "Discard changes",
    message: "Your template changes have not been saved.",
    title: "Discard unsaved changes?",
    tone: "danger",
  });
}

export function useUnsavedChanges(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const removeGuard = addNavigationGuard(confirmDiscardChanges);
    // Closing the tab can only use the browser's own prompt.
    const close = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", close);
    return () => {
      removeGuard();
      window.removeEventListener("beforeunload", close);
    };
  }, [dirty]);
}
