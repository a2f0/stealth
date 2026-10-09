import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";

/** Returns `entries` with the one at `from` moved to `to`. */
export function moveEntry<T>(entries: readonly T[], from: number, to: number) {
  const next = [...entries];
  if (from === to || !(from in next) || !(to in next)) return next;
  const [moved] = next.splice(from, 1) as [T];
  next.splice(to, 0, moved);
  return next;
}

/**
 * Where a dragged entry lands: after every other entry whose middle is above
 * the pointer.
 */
export function dropIndex(middles: number[], from: number, pointerY: number) {
  return middles.filter((middle, index) => index !== from && middle < pointerY)
    .length;
}

interface ReorderDrag {
  from: number;
  /** How far the pointer has moved since the drag began, scrolling included. */
  offset: number;
  to: number;
}

/** Near the viewport edge, a drag scrolls the page so far entries are reachable. */
const edgeScroll = { distance: 48, step: 16 };

/**
 * Reorders a list by dragging each entry's handle, or by pressing the arrow
 * keys on it. Entries mark themselves with `data-reorder-item` and share one
 * parent element. Pointer events work for mouse, pen, and touch alike.
 */
export function useReorderDrag(
  count: number,
  onMove: (from: number, to: number) => void,
) {
  const [drag, setDrag] = useState<ReorderDrag>();
  const latest = useRef<ReorderDrag | undefined>(undefined);
  const session = useRef<
    { from: number; items: HTMLElement[]; startY: number } | undefined
  >(undefined);

  function track(clientY: number) {
    const current = session.current;
    if (!current) return;
    const middles = current.items.map((item) => {
      const bounds = item.getBoundingClientRect();
      return bounds.top + bounds.height / 2;
    });
    latest.current = {
      from: current.from,
      offset: clientY + window.scrollY - current.startY,
      to: dropIndex(middles, current.from, clientY),
    };
    setDrag(latest.current);
  }

  function finish(commit: boolean) {
    const result = latest.current;
    session.current = undefined;
    latest.current = undefined;
    setDrag(undefined);
    if (commit && result && result.to !== result.from) {
      onMove(result.from, result.to);
    }
  }

  function handleProps(index: number) {
    return {
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        const step =
          event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
        if (step === 0) return;
        event.preventDefault();
        const to = index + step;
        if (to >= 0 && to < count) onMove(index, to);
      },
      onLostPointerCapture: () => {
        if (session.current) finish(false);
      },
      onPointerCancel: () => finish(false),
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        if (event.button !== 0) return;
        const item = event.currentTarget.closest("[data-reorder-item]");
        const list = item?.parentElement;
        if (!list) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        session.current = {
          from: index,
          items: [...list.children].filter(
            (child): child is HTMLElement =>
              child instanceof HTMLElement &&
              child.hasAttribute("data-reorder-item"),
          ),
          startY: event.clientY + window.scrollY,
        };
        latest.current = { from: index, offset: 0, to: index };
        setDrag(latest.current);
      },
      onPointerMove: (event: PointerEvent<HTMLElement>) => {
        if (!session.current) return;
        scrollNearEdge(event.clientY);
        track(event.clientY);
      },
      onPointerUp: () => finish(true),
    };
  }

  /** How one entry should look while something is being dragged. */
  function entryState(index: number) {
    if (!drag) return {};
    if (index === drag.from) return { dragging: true, offset: drag.offset };
    if (drag.to === drag.from || index !== drag.to) return {};
    return {
      drop: drag.to < drag.from ? ("before" as const) : ("after" as const),
    };
  }

  return { dragging: drag !== undefined, entryState, handleProps };
}

function scrollNearEdge(clientY: number) {
  if (clientY < edgeScroll.distance) {
    window.scrollBy?.(0, -edgeScroll.step);
  } else if (clientY > window.innerHeight - edgeScroll.distance) {
    window.scrollBy?.(0, edgeScroll.step);
  }
}
