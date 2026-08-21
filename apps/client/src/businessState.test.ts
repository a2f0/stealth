import { describe, expect, it } from "bun:test";
import { formatEin } from "./businessState";

describe("formatEin", () => {
  it("formats a normalized EIN for display", () => {
    expect(formatEin("123456789")).toBe("12-3456789");
    expect(formatEin("012345678")).toBe("01-2345678");
  });

  it("leaves unexpected values visible", () => {
    expect(formatEin("1234")).toBe("1234");
  });
});
