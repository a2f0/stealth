import { describe, expect, test } from "bun:test";
import { validateCommitSubject } from "./validateCommitSubject";

const rootDir = "/not-used-by-the-pure-validator";

describe("validateCommitSubject", () => {
  test("accepts a valid conventional subject", () => {
    expect(() =>
      validateCommitSubject(rootDir, "feat(agent-tool): add squash merge"),
    ).not.toThrow();
  });

  test("accepts the repo's custom 'cleanup' type", () => {
    expect(() =>
      validateCommitSubject(rootDir, "cleanup: drop dead code"),
    ).not.toThrow();
  });

  test("rejects a non-conventional subject", () => {
    expect(() => validateCommitSubject(rootDir, "just some text")).toThrow(
      /commitlint/,
    );
  });

  test("rejects an unknown type", () => {
    expect(() =>
      validateCommitSubject(rootDir, "frobnicate: do a thing"),
    ).toThrow(/commitlint/);
  });

  test("enforces the repo's 50-char header limit", () => {
    const tooLong = `feat(agent-tool): ${"x".repeat(50)}`;
    expect(() => validateCommitSubject(rootDir, tooLong)).toThrow(/commitlint/);
  });

  test.each([
    "feat: Add sentence case",
    "feat: finish with a period.",
    " feat: retain leading whitespace",
    "feat: retain trailing whitespace ",
    "feat: line one\nline two",
  ])("rejects the configured header rule violation in %s", (subject) => {
    expect(() => validateCommitSubject(rootDir, subject)).toThrow(/commitlint/);
  });

  test.each([
    "fix!: preserve a breaking marker",
    "feat(client)!: add a scoped breaking change",
    "docs: explain `API` behavior",
    "test: cover issue #123",
  ])("accepts the configured conventional header %s", (subject) => {
    expect(() => validateCommitSubject(rootDir, subject)).not.toThrow();
  });
});
