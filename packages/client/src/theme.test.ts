import { describe, expect, it } from "bun:test";
import {
  parseThemePreference,
  readThemePreference,
  resolveTheme,
  storeThemePreference,
  themeStorageKey,
} from "./theme";

describe("theme preference", () => {
  it("falls back to the system theme for unknown values", () => {
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("system")).toBe("system");
    expect(parseThemePreference("sepia")).toBe("system");
    expect(parseThemePreference(null)).toBe("system");
  });

  it("follows the system scheme only when the preference is system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("loads and stores the preference safely", () => {
    const stored = new Map<string, string>();
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        stored.set(key, value);
      },
    };
    expect(readThemePreference(storage)).toBe("system");
    storeThemePreference("dark", storage);
    expect(stored.get(themeStorageKey)).toBe("dark");
    expect(readThemePreference(storage)).toBe("dark");

    const blocked = {
      getItem: (): string | null => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readThemePreference(blocked)).toBe("system");
    expect(() => storeThemePreference("light", blocked)).not.toThrow();
  });

  it("matches the key the pre-paint script in index.html reads", async () => {
    const html = await Bun.file(
      new URL("../index.html", import.meta.url),
    ).text();
    expect(html).toContain(`localStorage.getItem("${themeStorageKey}")`);
  });
});
