import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { IconName } from "../icons";
import { Icon } from "./Icon";

interface ContextMenuAction {
  disabled?: boolean;
  icon?: IconName;
  id: string;
  label: string;
  onSelect: () => void;
}

interface ContextMenuTargetProps {
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

interface MenuLocation {
  trigger: HTMLElement;
  x: number;
  y: number;
}

/**
 * Attach the supplied handlers to an existing element, preserving its layout.
 * With `openOnClick`, a plain click opens the menu too, below the element,
 * for a control whose only job is to offer these actions.
 */
export function ContextMenu({
  children,
  items,
  label,
  openOnClick = false,
}: {
  children: (props: ContextMenuTargetProps) => ReactNode;
  items: readonly ContextMenuAction[];
  label: string;
  openOnClick?: boolean;
}) {
  const { close, location, targetProps } = useContextMenu(
    items.length > 0,
    openOnClick,
  );
  return (
    <>
      {children(targetProps)}
      {location &&
        createPortal(
          <ContextMenuPanel
            close={close}
            items={items}
            label={label}
            location={location}
          />,
          document.body,
        )}
    </>
  );
}

function useContextMenu(enabled: boolean, openOnClick: boolean) {
  const [location, setLocation] = useState<MenuLocation>();
  const close = useCallback(
    (restoreFocus = false) => {
      setLocation(undefined);
      if (restoreFocus) location?.trigger.focus();
    },
    [location],
  );
  const open = (
    event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>,
    point?: { x: number; y: number },
  ) => {
    if (!enabled || event.defaultPrevented || isEditable(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    const trigger = focusTarget(event.currentTarget, event.target);
    const bounds = trigger.getBoundingClientRect();
    setLocation({
      trigger,
      x: point?.x ?? bounds.left,
      y: point?.y ?? bounds.bottom,
    });
  };
  const targetProps: ContextMenuTargetProps = {
    onContextMenu: (event: MouseEvent<HTMLElement>) =>
      open(event, { x: event.clientX, y: event.clientY }),
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (
        event.key === "ContextMenu" ||
        (event.shiftKey && event.key === "F10")
      ) {
        open(event);
      }
    },
  };
  if (openOnClick) {
    targetProps.onClick = (event: MouseEvent<HTMLElement>) => open(event);
  }
  return { close, location, targetProps };
}

function isEditable(target: EventTarget) {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
      ),
    )
  );
}

function focusTarget(container: HTMLElement, target: EventTarget) {
  const selector =
    'a[href], button:not(:disabled), [tabindex]:not([tabindex="-1"]):not(:disabled)';
  const nearest =
    target instanceof Element ? target.closest<HTMLElement>(selector) : null;
  return nearest instanceof HTMLElement && container.contains(nearest)
    ? nearest
    : (container.querySelector<HTMLElement>(selector) ?? container);
}

function useContextMenuDismissal(
  menu: RefObject<HTMLDivElement | null>,
  close: (restoreFocus?: boolean) => void,
) {
  useEffect(() => {
    const outside = (event: Event) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target))
        close();
    };
    const keyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      } else if (event.key === "Tab") {
        close(true);
      }
    };
    const dismiss = () => close();
    const scroll = (event: Event) => {
      if (event.target instanceof Node && menu.current?.contains(event.target))
        return;
      close();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("contextmenu", outside, true);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", keyDown, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("contextmenu", outside, true);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", keyDown, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [close, menu]);
}

function ContextMenuPanel({
  close,
  items,
  label,
  location,
}: {
  close: (restoreFocus?: boolean) => void;
  items: readonly ContextMenuAction[];
  label: string;
  location: MenuLocation;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useContextMenuDismissal(menu, close);
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    const inset = 8;
    element.style.left = `${Math.max(inset, Math.min(location.x, window.innerWidth - bounds.width - inset))}px`;
    element.style.top = `${Math.max(inset, Math.min(location.y, window.innerHeight - bounds.height - inset))}px`;
    (
      element.querySelector<HTMLButtonElement>("button:not(:disabled)") ??
      element
    ).focus();
  }, [location]);
  return (
    <div
      aria-label={label}
      className="contextMenu"
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={navigateMenu}
      ref={menu}
      role="menu"
      tabIndex={-1}
    >
      {items.map((item) => (
        <button
          className="contextMenuItem"
          disabled={item.disabled}
          key={item.id}
          onClick={() => {
            close(true);
            item.onSelect();
          }}
          role="menuitem"
          tabIndex={-1}
          type="button"
        >
          {item.icon && <Icon name={item.icon} size={16} />}
          {item.label}
        </button>
      ))}
    </div>
  );
}

function navigateMenu(event: KeyboardEvent<HTMLDivElement>) {
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      "button:not(:disabled)",
    ),
  ];
  if (items.length === 0) return;
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  let next: HTMLButtonElement | undefined;
  switch (event.key) {
    case "ArrowDown":
      next = items[(index + 1) % items.length];
      break;
    case "ArrowUp":
      next = items[(index - 1 + items.length) % items.length];
      break;
    case "Home":
      next = items[0];
      break;
    case "End":
      next = items.at(-1);
      break;
    default:
      return;
  }
  event.preventDefault();
  event.stopPropagation();
  next?.focus();
}
