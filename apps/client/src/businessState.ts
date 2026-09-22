import type { Business } from "./businessesApi";

export function formatEin(ein: string) {
  return /^\d{9}$/.test(ein) ? `${ein.slice(0, 2)}-${ein.slice(2)}` : ein;
}

export function formatBusinessDate(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeZone: "UTC",
      }).format(date);
}

/** One line: street, then city with state and ZIP; blank parts are skipped. */
export function formatBusinessAddress(
  business: Pick<Business, "city" | "state" | "streetAddress" | "zip">,
) {
  const region = [business.state, business.zip].filter(Boolean).join(" ");
  const location = [business.city, region].filter(Boolean).join(", ");
  return [business.streetAddress, location].filter(Boolean).join(", ");
}
