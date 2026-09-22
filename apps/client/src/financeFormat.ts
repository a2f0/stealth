/** Formats an amount in its currency, or as a plain number without one. */
export function formatMoney(value: number | null, currency: string | null) {
  if (value === null) return "—";
  if (!currency) {
    return new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 2,
      minimumFractionDigits: 2,
    }).format(value);
  }
  return new Intl.NumberFormat(undefined, {
    currency,
    currencyDisplay: "narrowSymbol",
    style: "currency",
  }).format(value);
}
