import { describe, expect, it } from "bun:test";
import { formatMoney } from "./financeFormat";
import {
  categoryShare,
  financePageFor,
  isFinancePath,
  presetRange,
} from "./financePages";

describe("finance pages", () => {
  it("routes finance paths to their tabs", () => {
    expect(isFinancePath("/finance")).toBe(true);
    expect(isFinancePath("/finance/reports")).toBe(true);
    expect(isFinancePath("/financed")).toBe(false);
    expect(financePageFor("/finance")).toBe("overview");
    expect(financePageFor("/finance/reports")).toBe("reports");
    expect(financePageFor("/finance/categories")).toBe("categories");
    expect(financePageFor("/finance/unknown")).toBe("overview");
  });
});

describe("expense report ranges", () => {
  const today = new Date(2026, 8, 22);

  it("covers calendar periods up to today", () => {
    expect(presetRange("this-month", today)).toEqual({
      from: "2026-09-01",
      to: "2026-09-22",
    });
    expect(presetRange("last-month", today)).toEqual({
      from: "2026-08-01",
      to: "2026-08-31",
    });
    expect(presetRange("this-year", today)).toEqual({
      from: "2026-01-01",
      to: "2026-09-22",
    });
    expect(presetRange("last-12-months", today)).toEqual({
      from: "2025-10-01",
      to: "2026-09-22",
    });
    expect(presetRange("all-time", today)).toEqual({ from: null, to: null });
  });

  it("crosses year boundaries in January", () => {
    const january = new Date(2027, 0, 9);
    expect(presetRange("last-month", january)).toEqual({
      from: "2026-12-01",
      to: "2026-12-31",
    });
    expect(presetRange("last-12-months", january)).toEqual({
      from: "2026-02-01",
      to: "2027-01-09",
    });
  });

  it("sizes category bars as a share of positive spend", () => {
    expect(categoryShare(25, 100)).toBe(25);
    expect(categoryShare(150, 100)).toBe(100);
    expect(categoryShare(-20, 100)).toBe(0);
    expect(categoryShare(10, 0)).toBe(0);
  });

  it("formats amounts with or without a currency", () => {
    expect(formatMoney(null, "USD")).toBe("—");
    expect(formatMoney(12.5, "USD")).toContain("12.50");
    expect(formatMoney(12.5, "")).toBe(
      new Intl.NumberFormat(undefined, { minimumFractionDigits: 2 }).format(
        12.5,
      ),
    );
  });
});
