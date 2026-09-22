import { expect, test } from "bun:test";
import { countLabel, formatLabel } from "./labels";

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
  expect(formatLabel("")).toBe("");
});
