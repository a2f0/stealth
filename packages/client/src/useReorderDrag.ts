import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

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

interface DragSession {
  /** Where the pointer was last seen, for scrolls that don't move it. */
  clientY: number;
  from: number;
  items: HTMLElement[];
  pointerId: number;
  startY: number;
}

function reorderEntries(list: Element) {
  return [...list.children].filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.hasAttribute("data-reorder-item"),
  );
}

/** How one entry should look while something is being dragged. */
function entryStateFor(drag: ReorderDrag | undefined, index: number) {
  if (!drag) return {};
  if (index === drag.from) return { dragging: true, offset: drag.offset };
  if (drag.to === drag.from || index !== drag.to) return {};
  return {
    drop: drag.to < drag.from ? ("before" as const) : ("after" as const),
  };
}

/**
 * Near the viewport edge, a drag keeps scrolling the page, even while the
 * pointer holds still, so far entries are reachable.
 */
const edgeScroll = { distance: 48, step: 16 };

function edgeStep(clientY: number) {
  if (clientY < edgeScroll.distance) return -edgeScroll.step;
  if (clientY > window.innerHeight - edgeScroll.distance)
    return edgeScroll.step;
  return 0;
}

/**
 * Scrolls a frame at a time while the pointer rests near a viewport edge,
 * calling `onScroll` with the pointer's position after each step. It never
 * scrolls past where the page ended when the drag began: the lifted entry's
 * transform grows the page as it follows the pointer, and would otherwise
 * let the scroll run on into empty space.
 */
function useEdgeScroll(onScroll: (clientY: number) => void) {
  const pointerY = useRef(0);
  const frame = useRef<number | undefined>(undefined);
  const limit = useRef(0);
  const scrolled = useRef(onScroll);
  scrolled.current = onScroll;
  const stop = useCallback(() => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
  }, []);
  useEffect(() => stop, [stop]);

  function step() {
    frame.current = undefined;
    const target = Math.min(
      limit.current,
      Math.max(0, window.scrollY + edgeStep(pointerY.current)),
    );
    const distance = target - window.scrollY;
    // Out of the edge zone, or already at the end of the page.
    if (distance === 0) return;
    window.scrollBy(0, distance);
    scrolled.current(pointerY.current);
    frame.current = requestAnimationFrame(step);
  }

  return {
    begin() {
      limit.current = Math.max(
        0,
        document.documentElement.scrollHeight - window.innerHeight,
      );
    },
    follow(clientY: number) {
      pointerY.current = clientY;
      if (frame.current === undefined && edgeStep(clientY) !== 0) {
        frame.current = requestAnimationFrame(step);
      }
    },
    stop,
  };
}

/**
 * Wheel or keyboard scrolling during a drag moves the entries under a still
 * pointer; `onScroll` refreshes the drop point and the lifted entry.
 */
function useScrollWhileDragging(dragging: boolean, onScroll: () => void) {
  const latest = useRef(onScroll);
  latest.current = onScroll;
  useEffect(() => {
    if (!dragging) return;
    const refresh = () => latest.current();
    window.addEventListener("scroll", refresh, { passive: true });
    return () => window.removeEventListener("scroll", refresh);
  }, [dragging]);
}

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
  /** One drag at a time, owned by the pointer that started it. */
  const session = useRef<DragSession | undefined>(undefined);
  const owns = (event: PointerEvent<HTMLElement>) =>
    session.current?.pointerId === event.pointerId;
  const edge = useEdgeScroll(track);
  useScrollWhileDragging(drag !== undefined, () => {
    if (session.current) track(session.current.clientY);
  });

  function track(clientY: number) {
    const current = session.current;
    if (!current) return;
    current.clientY = clientY;
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
    edge.stop();
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
      onLostPointerCapture: (event: PointerEvent<HTMLElement>) => {
        if (owns(event)) finish(false);
      },
      onPointerCancel: (event: PointerEvent<HTMLElement>) => {
        if (owns(event)) finish(false);
      },
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        // A second finger or pen cannot take over a drag in progress.
        if (event.button !== 0 || session.current) return;
        const item = event.currentTarget.closest("[data-reorder-item]");
        const list = item?.parentElement;
        if (!list) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        edge.begin();
        session.current = {
          from: index,
          items: reorderEntries(list),
          clientY: event.clientY,
          pointerId: event.pointerId,
          startY: event.clientY + window.scrollY,
        };
        latest.current = { from: index, offset: 0, to: index };
        setDrag(latest.current);
      },
      onPointerMove: (event: PointerEvent<HTMLElement>) => {
        if (!owns(event)) return;
        track(event.clientY);
        edge.follow(event.clientY);
      },
      onPointerUp: (event: PointerEvent<HTMLElement>) => {
        if (!owns(event)) return;
        // Settle the drop point where the pointer let go, after any scrolling.
        track(event.clientY);
        finish(true);
      },
    };
  }

  return {
    dragging: drag !== undefined,
    entryState: (index: number) => entryStateFor(drag, index),
    handleProps,
  };
}
