import { expect, test } from "bun:test";
import { initialsFor } from "./Identity";

test("initials come from the first two words of a name", () => {
  expect(initialsFor("Avery Designer")).toBe("AD");
  expect(initialsFor("Mary-Jane Smith")).toBe("MS");
  expect(initialsFor("Mary Ann Smith")).toBe("MA");
  expect(initialsFor("U.S. Bank")).toBe("UB");
  expect(initialsFor("  jordan   lee ")).toBe("JL");
});

test("a single word falls back to its separated parts", () => {
  expect(initialsFor("jane.doe@example.com")).toBe("JD");
  expect(initialsFor("Mary-Jane")).toBe("MJ");
  expect(initialsFor("Cher")).toBe("C");
});

test("an empty name has a placeholder", () => {
  expect(initialsFor("")).toBe("?");
  expect(initialsFor("   ")).toBe("?");
});
