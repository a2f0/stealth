import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useState,
} from "react";
import {
  clampSidebarWidth,
  defaultSidebarWidth,
  maximumSidebarWidth,
  minimumSidebarWidth,
  sidebarWidthForKey,
  storeSidebarWidth,
} from "./sidebarWidth";

interface SidebarResizeHandleProps {
  onWidthChange: (width: number) => void;
  width: number;
}

export function SidebarResizeHandle({
  onWidthChange,
  width,
}: SidebarResizeHandleProps) {
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    document.body.classList.toggle("sidebarResizing", dragging);
    return () => document.body.classList.remove("sidebarResizing");
  }, [dragging]);

  function startDragging(event: ReactPointerEvent<HTMLHRElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }

  function continueDragging(event: ReactPointerEvent<HTMLHRElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    onWidthChange(clampSidebarWidth(event.clientX));
  }

  function finishDragging(event: ReactPointerEvent<HTMLHRElement>) {
    const nextWidth = clampSidebarWidth(event.clientX);
    onWidthChange(nextWidth);
    storeSidebarWidth(nextWidth);
    setDragging(false);
  }

  function cancelDragging() {
    storeSidebarWidth(width);
    setDragging(false);
  }

  function resizeWithKeyboard(event: ReactKeyboardEvent<HTMLHRElement>) {
    const nextWidth = sidebarWidthForKey(width, event.key);
    if (nextWidth === undefined) return;
    event.preventDefault();
    onWidthChange(nextWidth);
    storeSidebarWidth(nextWidth);
  }

  function resetWidth() {
    onWidthChange(defaultSidebarWidth);
    storeSidebarWidth(defaultSidebarWidth);
  }

  return (
    <hr
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-valuemax={maximumSidebarWidth}
      aria-valuemin={minimumSidebarWidth}
      aria-valuenow={Math.round(width)}
      className={`sidebarResizeHandle${dragging ? " dragging" : ""}`}
      onDoubleClick={resetWidth}
      onKeyDown={resizeWithKeyboard}
      onPointerCancel={cancelDragging}
      onPointerDown={startDragging}
      onPointerMove={continueDragging}
      onPointerUp={finishDragging}
      tabIndex={0}
      title="Drag to resize the sidebar; double-click to reset"
    />
  );
}
