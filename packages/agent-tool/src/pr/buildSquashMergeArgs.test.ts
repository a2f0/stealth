import { describe, expect, test } from "bun:test";

import {
  assertExpectedBaseCommit,
  assertExpectedHeadCommit,
  assertGuardPair,
  assertImmediatelyMergeable,
  assertMergeRequirements,
  assertReviewedAncestry,
  buildAtomicPushArgs,
  buildReviewedCommitArgs,
  buildSquashMergeArgs,
  mergeStateExitCode,
  mergeWaitExitCode,
  selectGuardedMergeStrategy,
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
      "--auto",
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

  test("omits delayed auto-merge for guarded API merges", () => {
    const args = buildSquashMergeArgs(pr, "feat: x (#1537)", "abc123", false);
    expect(args).not.toContain("--auto");
    expect(args).toContain("--match-head-commit");
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
    ).not.toThrow();
    expect(() =>
      assertMergeRequirements({
        ...mergeablePr,
        mergeStateStatus: "BLOCKED",
      }),
    ).not.toThrow();
    expect(() =>
      assertMergeRequirements({ ...mergeablePr, mergeable: "CONFLICTING" }),
    ).toThrow("merge conflicts");
    expect(() =>
      assertMergeRequirements({ ...mergeablePr, mergeable: "UNKNOWN" }),
    ).not.toThrow();
    expect(() => assertImmediatelyMergeable(mergeablePr)).not.toThrow();
    expect(() =>
      assertImmediatelyMergeable({
        ...mergeablePr,
        reviewDecision: "REVIEW_REQUIRED",
      }),
    ).toThrow("immediately mergeable without auto-merge");
    expect(() =>
      assertImmediatelyMergeable({
        ...mergeablePr,
        mergeStateStatus: "BLOCKED",
      }),
    ).toThrow("immediately mergeable without auto-merge");
    expect(() =>
      assertImmediatelyMergeable({ ...mergeablePr, mergeable: "UNKNOWN" }),
    ).toThrow("immediately mergeable without auto-merge");
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

  test("uses ref CAS only without policy and API only with strict policy", () => {
    expect(selectGuardedMergeStrategy(null, [])).toBe("atomic_refs");
    expect(
      selectGuardedMergeStrategy(
        { required_status_checks: { strict: true } },
        [],
      ),
    ).toBe("github_api");
    expect(
      selectGuardedMergeStrategy(null, [
        {
          parameters: { strict_required_status_checks_policy: true },
          type: "required_status_checks",
        },
      ]),
    ).toBe("github_api");
    expect(() =>
      selectGuardedMergeStrategy(null, [{ type: "merge_queue" }]),
    ).toThrow("does not support an active merge queue");
    expect(() =>
      selectGuardedMergeStrategy({ required_status_checks: { strict: true } }, [
        { type: "merge_queue" },
      ]),
    ).toThrow("does not support an active merge queue");
    expect(() =>
      selectGuardedMergeStrategy({ required_pull_request_reviews: {} }, []),
    ).toThrow("does not require branches to be up to date");
  });

  test("builds a one-parent squash commit", () => {
    expect(buildReviewedCommitArgs("tree-1", "base-1")).toEqual([
      "commit-tree",
      "tree-1",
      "-p",
      "base-1",
    ]);
  });

  test("atomically leases both reviewed refs", () => {
    expect(
      buildAtomicPushArgs(
        "https://github.com/a2f0/stealth",
        "merge-1",
        "main",
        "base-1",
        "feat/widget",
        "head-1",
      ),
    ).toEqual([
      "-c",
      "credential.helper=",
      "-c",
      "credential.helper=!gh auth git-credential",
      "-c",
      "core.hooksPath=/dev/null",
      "push",
      "--porcelain",
      "--atomic",
      "--force-with-lease=refs/heads/main:base-1",
      "--force-with-lease=refs/heads/feat/widget:head-1",
      "https://github.com/a2f0/stealth",
      "merge-1:refs/heads/main",
      "merge-1:refs/heads/feat/widget",
    ]);
  });

  test("waits through active states and recognizes terminal states", () => {
    expect(mergeStateExitCode("OPEN")).toBeNull();
    expect(mergeStateExitCode("QUEUED")).toBeNull();
    expect(mergeStateExitCode("MERGED")).toBe(0);
    expect(mergeStateExitCode("CLOSED")).toBe(1);
    expect(mergeWaitExitCode("OPEN", 599_999, 600_000)).toBeNull();
    expect(mergeWaitExitCode("OPEN", 600_000, 600_000)).toBe(2);
    expect(mergeWaitExitCode("MERGED", 600_000, 600_000)).toBe(0);
  });
});
