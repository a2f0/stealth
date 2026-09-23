import { expect, test } from "bun:test";
import { countLabel, formatBytes, formatLabel } from "./labels";

test("countLabel pluralizes regular and irregular nouns", () => {
  expect(countLabel(0, "audit")).toBe("0 audits");
  expect(countLabel(1, "audit")).toBe("1 audit");
  expect(countLabel(2, "audit")).toBe("2 audits");
  expect(countLabel(1, "business", "businesses")).toBe("1 business");
  expect(countLabel(3, "business", "businesses")).toBe("3 businesses");
});

test("formatLabel turns machine values into sentence case", () => {
  expect(formatLabel("in_progress")).toBe("In progress");
  expect(formatLabel("past_due")).toBe("Past due");
  expect(formatLabel("high")).toBe("High");
  expect(formatLabel("FOOD_AND_DRINK")).toBe("Food and drink");
  expect(formatLabel("")).toBe("");
});

test("formatBytes uses the largest sensible unit", () => {
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(3_500)).toBe("3.4 KB");
  expect(formatBytes(12 * 1024 * 1024)).toBe("12.0 MB");
});
