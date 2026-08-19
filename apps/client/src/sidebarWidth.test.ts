import { describe, expect, it } from "bun:test";
import {
  clampSidebarWidth,
  defaultSidebarWidth,
  maximumSidebarWidth,
  minimumSidebarWidth,
  readSidebarWidth,
  sidebarWidthForKey,
  storeSidebarWidth,
} from "./sidebarWidth";

describe("sidebar width", () => {
  it("clamps pointer widths to the supported desktop range", () => {
    expect(clampSidebarWidth(120)).toBe(minimumSidebarWidth);
    expect(clampSidebarWidth(312)).toBe(312);
    expect(clampSidebarWidth(500)).toBe(maximumSidebarWidth);
    expect(clampSidebarWidth(Number.NaN)).toBe(defaultSidebarWidth);
  });

  it("supports keyboard resizing and reset", () => {
    expect(sidebarWidthForKey(240, "ArrowLeft")).toBe(224);
    expect(sidebarWidthForKey(240, "ArrowRight")).toBe(256);
    expect(sidebarWidthForKey(320, "Home")).toBe(defaultSidebarWidth);
    expect(sidebarWidthForKey(240, "Enter")).toBeUndefined();
  });

  it("loads and stores a persistent width safely", () => {
    let stored: string | null = "318";
    const storage = {
      getItem: () => stored,
      setItem: (_key: string, value: string) => {
        stored = value;
      },
    };
    expect(readSidebarWidth(storage)).toBe(318);
    storeSidebarWidth(900, storage);
    expect(stored).toBe(String(maximumSidebarWidth));
  });
});
