import { useSyncExternalStore } from "react";

export type ThemePreference = "dark" | "light" | "system";
type Theme = "dark" | "light";

// index.html reads this key before first paint; keep the two in sync.
export const themeStorageKey = "tearleads.theme";
const darkSchemeQuery = "(prefers-color-scheme: dark)";

interface StorageReader {
  getItem(key: string): string | null;
}

interface StorageWriter {
  setItem(key: string, value: string): void;
}

export function parseThemePreference(value: string | null): ThemePreference {
  return value === "dark" || value === "light" ? value : "system";
}

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): Theme {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}

export function readThemePreference(storage?: StorageReader) {
  try {
    const availableStorage = storage ?? window.localStorage;
    return parseThemePreference(availableStorage.getItem(themeStorageKey));
  } catch {
    return "system";
  }
}

export function storeThemePreference(
  preference: ThemePreference,
  storage?: StorageWriter,
) {
  try {
    const availableStorage = storage ?? window.localStorage;
    availableStorage.setItem(themeStorageKey, preference);
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}

let currentPreference: ThemePreference | undefined;
const listeners = new Set<() => void>();

function preferenceSnapshot() {
  currentPreference ??= readThemePreference();
  return currentPreference;
}

function applyTheme() {
  document.documentElement.setAttribute(
    "data-theme",
    resolveTheme(
      preferenceSnapshot(),
      window.matchMedia(darkSchemeQuery).matches,
    ),
  );
}

function updatePreference(preference: ThemePreference) {
  currentPreference = preference;
  applyTheme();
  for (const listener of listeners) listener();
}

export function setThemePreference(preference: ThemePreference) {
  storeThemePreference(preference);
  updatePreference(preference);
}

/**
 * Keeps <html data-theme> current as the system scheme changes and as other
 * tabs change the preference. Returns a function that stops listening.
 */
export function startThemeSync() {
  const systemScheme = window.matchMedia(darkSchemeQuery);
  const followSystem = () => applyTheme();
  const followOtherTabs = (event: StorageEvent) => {
    if (event.key === themeStorageKey) {
      updatePreference(parseThemePreference(event.newValue));
    }
  };
  applyTheme();
  systemScheme.addEventListener("change", followSystem);
  window.addEventListener("storage", followOtherTabs);
  return () => {
    systemScheme.removeEventListener("change", followSystem);
    window.removeEventListener("storage", followOtherTabs);
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useThemePreference() {
  return useSyncExternalStore(
    subscribe,
    preferenceSnapshot,
    (): ThemePreference => "system",
  );
}
