import { describe, expect, it } from "bun:test";
import { formatBusinessDate, formatEin } from "./businessState";

describe("formatEin", () => {
  it("formats a normalized EIN for display", () => {
    expect(formatEin("123456789")).toBe("12-3456789");
    expect(formatEin("012345678")).toBe("01-2345678");
  });

  it("leaves unexpected values visible", () => {
    expect(formatEin("1234")).toBe("1234");
  });
});

describe("formatBusinessDate", () => {
  it("formats an ISO date without shifting time zones", () => {
    const expected = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeZone: "UTC",
    }).format(new Date("2026-08-22T00:00:00.000Z"));
    expect(formatBusinessDate("2026-08-22")).toBe(expected);
  });

  it("leaves unexpected values visible", () => {
    expect(formatBusinessDate("unknown")).toBe("unknown");
  });
});
