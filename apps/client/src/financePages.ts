export type FinancePage = "categories" | "overview" | "reports";

export const financePages: {
  label: string;
  page: FinancePage;
  path: string;
}[] = [
  { label: "Overview", page: "overview", path: "/finance" },
  { label: "Reports", page: "reports", path: "/finance/reports" },
  { label: "Categories", page: "categories", path: "/finance/categories" },
];

export function isFinancePath(pathname: string) {
  return pathname === "/finance" || pathname.startsWith("/finance/");
}

/** Unknown finance subpaths fall back to the overview. */
export function financePageFor(pathname: string): FinancePage {
  return (
    financePages.find(({ path }) => path !== "/finance" && path === pathname)
      ?.page ?? "overview"
  );
}

export type ReportPreset =
  | "all-time"
  | "custom"
  | "last-12-months"
  | "last-month"
  | "this-month"
  | "this-year";

export const reportPresets: { label: string; preset: ReportPreset }[] = [
  { label: "This month", preset: "this-month" },
  { label: "Last month", preset: "last-month" },
  { label: "This year", preset: "this-year" },
  { label: "Last 12 months", preset: "last-12-months" },
  { label: "All time", preset: "all-time" },
  { label: "Custom", preset: "custom" },
];

export interface ReportRange {
  from: string | null;
  to: string | null;
}

/** Calendar ranges in the viewer's local time, as YYYY-MM-DD strings. */
export function presetRange(
  preset: Exclude<ReportPreset, "custom">,
  today: Date,
): ReportRange {
  const year = today.getFullYear();
  const month = today.getMonth();
  const end = isoDate(today);
  if (preset === "this-month") {
    return { from: isoDate(new Date(year, month, 1)), to: end };
  }
  if (preset === "last-month") {
    return {
      from: isoDate(new Date(year, month - 1, 1)),
      to: isoDate(new Date(year, month, 0)),
    };
  }
  if (preset === "this-year") {
    return { from: isoDate(new Date(year, 0, 1)), to: end };
  }
  if (preset === "last-12-months") {
    return { from: isoDate(new Date(year, month - 11, 1)), to: end };
  }
  return { from: null, to: null };
}

/** A category's share of the total as a 0–100 percentage for its bar. */
export function categoryShare(total: number, grandTotal: number) {
  if (total <= 0 || grandTotal <= 0) return 0;
  return Math.min(100, (total / grandTotal) * 100);
}

function isoDate(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}
