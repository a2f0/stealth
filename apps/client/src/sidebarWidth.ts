export const defaultSidebarWidth = 240;
export const maximumSidebarWidth = 400;
export const minimumSidebarWidth = 200;

const sidebarWidthStorageKey = "stealth.sidebar-width";
const keyboardResizeStep = 16;

interface StorageReader {
  getItem(key: string): string | null;
}

interface StorageWriter {
  setItem(key: string, value: string): void;
}

export function clampSidebarWidth(width: number) {
  if (!Number.isFinite(width)) return defaultSidebarWidth;
  return Math.min(maximumSidebarWidth, Math.max(minimumSidebarWidth, width));
}

export function sidebarWidthForKey(width: number, key: string) {
  if (key === "ArrowLeft") {
    return clampSidebarWidth(width - keyboardResizeStep);
  }
  if (key === "ArrowRight") {
    return clampSidebarWidth(width + keyboardResizeStep);
  }
  if (key === "Home") return defaultSidebarWidth;
  return undefined;
}

export function readSidebarWidth(storage?: StorageReader) {
  try {
    const availableStorage = storage ?? window.localStorage;
    const storedWidth = availableStorage.getItem(sidebarWidthStorageKey);
    if (storedWidth === null) return defaultSidebarWidth;
    return clampSidebarWidth(Number(storedWidth));
  } catch {
    return defaultSidebarWidth;
  }
}

export function storeSidebarWidth(width: number, storage?: StorageWriter) {
  try {
    const availableStorage = storage ?? window.localStorage;
    availableStorage.setItem(
      sidebarWidthStorageKey,
      String(clampSidebarWidth(width)),
    );
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}
