import { expect, test } from "bun:test";
import { progressFor } from "./AuditRunPage";
import type { AuditDefinition, AuditTemplateItem } from "./auditApi";

function item(id: string, required: boolean): AuditTemplateItem {
  return { id, prompt: `Question ${id}`, required, responseType: "check" };
}

const definition: AuditDefinition = {
  sections: [
    { id: "a", items: [item("a1", true), item("a2", true)], title: "A" },
    { id: "b", items: [item("b1", false), item("b2", true)], title: "B" },
  ],
  version: 1,
};

test("progress counts every answered item across sections", () => {
  expect(progressFor(definition, { a1: "pass", b1: "na" })).toEqual({
    answered: 2,
    failed: 0,
    requiredLeft: 2,
    total: 4,
  });
});

test("whitespace-only responses are unanswered, matching the server", () => {
  expect(progressFor(definition, { a1: "   ", a2: "\n" })).toMatchObject({
    answered: 0,
    requiredLeft: 3,
  });
});

test("failed answers are counted and still count as answered", () => {
  expect(
    progressFor(definition, { a1: "fail", a2: "fail", b2: "pass" }),
  ).toEqual({ answered: 3, failed: 2, requiredLeft: 0, total: 4 });
});

test("optional items never block completion", () => {
  expect(
    progressFor(definition, { a1: "pass", a2: "pass", b2: "na" }).requiredLeft,
  ).toBe(0);
});
