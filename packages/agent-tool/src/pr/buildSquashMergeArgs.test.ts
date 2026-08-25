import { describe, expect, test } from "bun:test";

import {
  assertExpectedBaseCommit,
  assertExpectedHeadCommit,
  assertGuardPair,
  assertMergeRequirements,
  assertReviewedAncestry,
  buildSquashMergeArgs,
} from "./squashMerge";

const pr = { prNumber: "1537", repo: "a2f0/stealth" };
const mergeablePr = {
  ...pr,
  baseRefName: "main",
  baseRefOid: "base-1",
  branch: "feat/widget",
  headRefName: "feat/widget",
  headRefOid: "head-1",
  headRepository: "a2f0/stealth",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
  title: "feat: x",
};

describe("buildSquashMergeArgs", () => {
  test("builds a subject-only squash with an empty body", () => {
    expect(buildSquashMergeArgs(pr, "feat(app): add widget (#1537)")).toEqual([
      "pr",
      "merge",
      "1537",
      "--squash",
      "--subject",
      "feat(app): add widget (#1537)",
      "--body",
      "",
      "-R",
      "a2f0/stealth",
    ]);
  });

  test("omits --match-head-commit when no head SHA is given", () => {
    const args = buildSquashMergeArgs(pr, "feat: x (#1537)");
    expect(args).not.toContain("--match-head-commit");
  });

  test("binds the merge to the head SHA when provided", () => {
    const args = buildSquashMergeArgs(pr, "feat: x (#1537)", "abc123");
    const flagIndex = args.indexOf("--match-head-commit");
    expect(flagIndex).toBeGreaterThan(-1);
    expect(args[flagIndex + 1]).toBe("abc123");
  });

  test("treats an empty head SHA as absent", () => {
    const args = buildSquashMergeArgs(pr, "feat: x (#1537)", "");
    expect(args).not.toContain("--match-head-commit");
  });
});

describe("assertExpectedBaseCommit", () => {
  test("accepts the reviewed base and an omitted base guard", () => {
    expect(() => assertExpectedBaseCommit("base-1", "base-1")).not.toThrow();
    expect(() => assertExpectedBaseCommit(undefined, "base-1")).not.toThrow();
  });

  test("requires re-review when the base moves", () => {
    expect(() => assertExpectedBaseCommit("base-1", "base-2")).toThrow(
      "sync and re-review",
    );
  });
});

describe("reviewed merge guards", () => {
  test("enforces GitHub draft, review, and status requirements", () => {
    expect(() => assertMergeRequirements(mergeablePr)).not.toThrow();
    expect(() =>
      assertMergeRequirements({ ...mergeablePr, isDraft: true }),
    ).toThrow("draft");
    expect(() =>
      assertMergeRequirements({
        ...mergeablePr,
        reviewDecision: "REVIEW_REQUIRED",
      }),
    ).toThrow("approving review");
    expect(() =>
      assertMergeRequirements({
        ...mergeablePr,
        mergeStateStatus: "BLOCKED",
      }),
    ).toThrow("not clean");
    expect(() =>
      assertMergeRequirements({ ...mergeablePr, mergeable: "CONFLICTING" }),
    ).toThrow("not MERGEABLE");
  });

  test("requires the reviewed head and base together", () => {
    expect(() => assertGuardPair("head", "base")).not.toThrow();
    expect(() => assertGuardPair(undefined, undefined)).not.toThrow();
    expect(() => assertGuardPair("head", undefined)).toThrow("requires both");
    expect(() => assertGuardPair(undefined, "base")).toThrow("requires both");
  });

  test("rejects a PR head that moved after review", () => {
    expect(() => assertExpectedHeadCommit("head-1", "head-2")).toThrow(
      "re-review",
    );
  });

  test("requires the reviewed head to contain the reviewed base", () => {
    expect(() => assertReviewedAncestry(0)).not.toThrow();
    expect(() => assertReviewedAncestry(1)).toThrow("sync the base");
    expect(() => assertReviewedAncestry(128)).toThrow("Could not verify");
  });
});
