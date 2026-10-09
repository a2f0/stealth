import { useEffect, useRef } from "react";

/**
 * Folding a form away (cancelled, or its work was saved) removes the focused
 * field; hand focus to the button that reopens it.
 */
export function useFocusWhenFolded(formOpen: boolean) {
  const button = useRef<HTMLButtonElement>(null);
  const wasFormOpen = useRef(formOpen);
  useEffect(() => {
    if (wasFormOpen.current && !formOpen) button.current?.focus();
    wasFormOpen.current = formOpen;
  }, [formOpen]);
  return button;
}
