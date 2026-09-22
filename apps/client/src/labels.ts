/** "1 audit", "3 audits"; pass the plural when appending "s" is wrong. */
export function countLabel(
  count: number,
  singular: string,
  plural = `${singular}s`,
) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Display text for a machine value, e.g. "in_progress" → "In progress" or
 * Plaid's "FOOD_AND_DRINK" → "Food and drink".
 */
export function formatLabel(value: string) {
  const text = value.toLowerCase().replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
