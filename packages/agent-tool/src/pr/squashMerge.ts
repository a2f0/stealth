import { spawnSync } from "node:child_process";

import {
  type PrMergeIdentity,
  prState,
  resolveFreshBaseRef,
  resolvePr,
  spawnExitCode,
} from "../git/prContext";
import { appendPrNumberSuffix, stripPrNumberSuffix } from "./prNumberSuffix";
import { singleLineSubject } from "./subjectLine";
import { validateCommitSubject } from "./validateCommitSubject";

/**
 * Resolve the squash subject from the CLI argument, falling back to the PR
 * title. Rejects an empty subject and any embedded line break so the squash
 * commit stays a single subject line.
 */
export function resolveSubject(
  subjectArg: string | undefined,
  prTitle: string,
): string {
  return singleLineSubject(subjectArg, prTitle, "squash subject");
}

/**
 * Build the `gh pr merge` argv for a subject-only squash. When
 * `expectedHeadSha` is provided, `--match-head-commit` makes GitHub reject the
 * merge unless the PR head is exactly that commit — closing the window where a
 * commit pushed after a review could be merged unreviewed (used by `ship-pr`).
 */
export function buildSquashMergeArgs(
  pr: { prNumber: string; repo: string },
  finalSubject: string,
  expectedHeadSha?: string,
): string[] {
  const args = [
    "pr",
    "merge",
    pr.prNumber,
    "--squash",
    "--subject",
    finalSubject,
    // Empty body keeps the squash commit to the subject line only.
    "--body",
    "",
    "-R",
    pr.repo,
  ];
  if (expectedHeadSha !== undefined && expectedHeadSha.length > 0) {
    // GitHub atomically refuses the merge if the PR head has moved off this SHA.
    args.push("--match-head-commit", expectedHeadSha);
  }
  return args;
}

export function assertExpectedBaseCommit(
  expectedBaseSha: string | undefined,
  actualBaseSha: string,
): void {
  if (
    expectedBaseSha !== undefined &&
    expectedBaseSha.length > 0 &&
    expectedBaseSha !== actualBaseSha
  ) {
    throw new Error(
      `PR base moved from reviewed commit ${expectedBaseSha} to ${actualBaseSha}; sync and re-review before merging.`,
    );
  }
}

export function assertExpectedHeadCommit(
  expectedHeadSha: string,
  actualHeadSha: string,
): void {
  if (expectedHeadSha !== actualHeadSha) {
    throw new Error(
      `PR head moved from reviewed commit ${expectedHeadSha} to ${actualHeadSha}; re-review before merging.`,
    );
  }
}

export function assertGuardPair(
  expectedHeadSha: string | undefined,
  expectedBaseSha: string | undefined,
): void {
  const hasHead = (expectedHeadSha?.length ?? 0) > 0;
  const hasBase = (expectedBaseSha?.length ?? 0) > 0;
  if (hasHead !== hasBase) {
    throw new Error(
      "A guarded merge requires both the reviewed head SHA and reviewed base SHA.",
    );
  }
}

export function assertReviewedAncestry(status: number | null): void {
  if (status === 0) return;
  if (status === 1) {
    throw new Error(
      "The reviewed base is not an ancestor of the reviewed head; sync the base and re-review before merging.",
    );
  }
  throw new Error(
    `Could not verify reviewed base ancestry (git exited ${status ?? "on a signal"}).`,
  );
}

/** Fail early with an actionable reason; GitHub re-enforces this on merge. */
export function assertMergeRequirements(pr: PrMergeIdentity): void {
  if (pr.isDraft) {
    throw new Error("The PR is a draft and cannot be merged.");
  }
  if (pr.mergeable !== "MERGEABLE") {
    throw new Error(
      `GitHub reports the PR as ${pr.mergeable || "UNKNOWN"}, not MERGEABLE.`,
    );
  }
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    throw new Error("The PR has unresolved requested changes.");
  }
  if (pr.reviewDecision === "REVIEW_REQUIRED") {
    throw new Error("The PR still requires an approving review.");
  }
  if (pr.mergeStateStatus !== "CLEAN") {
    throw new Error(
      `GitHub merge requirements are not clean (state: ${pr.mergeStateStatus || "UNKNOWN"}).`,
    );
  }
}

function assertSameMergeTarget(
  initial: PrMergeIdentity,
  fresh: PrMergeIdentity,
): void {
  if (
    initial.prNumber !== fresh.prNumber ||
    initial.repo !== fresh.repo ||
    initial.baseRefName !== fresh.baseRefName ||
    initial.headRefName !== fresh.headRefName ||
    initial.headRepository !== fresh.headRepository
  ) {
    throw new Error("The PR merge target changed during guarded merge setup.");
  }
}

/**
 * Squash through GitHub's policy-enforcing merge API. The API atomically binds
 * the reviewed head; the reviewed base is fetched, ancestry-checked, and
 * required to remain GitHub's current base immediately before the mutation.
 */
function guardedReviewedMerge(
  pr: ReturnType<typeof resolvePr>,
  finalSubject: string,
  expectedHeadSha: string,
  expectedBaseSha: string,
): number {
  assertExpectedHeadCommit(expectedHeadSha, pr.headRefOid);
  assertExpectedBaseCommit(expectedBaseSha, pr.baseRefOid);
  if (pr.baseRefName.length === 0) {
    throw new Error("Could not determine the PR base branch.");
  }
  // Require the reviewed head to include the reviewed base so the policy-
  // checked API never merges a stale, unintegrated candidate.
  resolveFreshBaseRef(pr.repo, pr.baseRefName, expectedBaseSha);
  const ancestry = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", expectedBaseSha, expectedHeadSha],
    { stdio: "ignore" },
  );
  if (ancestry.error) throw ancestry.error;
  if (ancestry.signal !== null) {
    throw new Error(
      `Could not verify reviewed base ancestry (git terminated by ${ancestry.signal}).`,
    );
  }
  assertReviewedAncestry(ancestry.status);

  // Refresh immediately before asking GitHub to merge. The API performs the
  // final policy check atomically with its mutation; unlike a direct ref push,
  // this cannot race a dismissed approval or newly failing required check.
  const freshPr = resolvePr();
  assertSameMergeTarget(pr, freshPr);
  assertExpectedHeadCommit(expectedHeadSha, freshPr.headRefOid);
  assertExpectedBaseCommit(expectedBaseSha, freshPr.baseRefOid);
  assertMergeRequirements(freshPr);

  const mergeResult = spawnSync(
    "gh",
    buildSquashMergeArgs(freshPr, finalSubject, expectedHeadSha),
    { stdio: "inherit" },
  );
  const mergeExitCode = spawnExitCode("gh pr merge", mergeResult);
  if (mergeExitCode !== 0) return mergeExitCode;

  const state = prState(pr.prNumber, pr.repo);
  if (state !== "MERGED") {
    process.stderr.write(
      `PR #${pr.prNumber} is not merged (state: ${state || "unknown"}). ` +
        "It may be queued or blocked; the reviewed squash is not complete.\n",
    );
    return 1;
  }
  return 0;
}

/**
 * Squash-merge the open PR for the current branch with a subject-only commit
 * message — no auto-generated body or extended message. The subject defaults to
 * the PR title when one is not supplied, and is validated against the repo's
 * commitlint rules before the merge runs. When both review SHAs are supplied,
 * the guarded path checks that exact pair and asks GitHub's merge API to enforce
 * PR policy while atomically binding the reviewed head. Without guards, the
 * compatibility path uses the same API without the review/base checks.
 */
export function squashMerge(
  rootDir: string,
  subjectArg: string | undefined,
  expectedHeadSha?: string,
  expectedBaseSha?: string,
): number {
  const pr = resolvePr();
  const subject = resolveSubject(subjectArg, pr.title);

  // Validate the human-authored subject without the PR-number suffix: GitHub's
  // native squash appends `(#<n>)` server-side, past the commit-msg hook, so the
  // repo's existing history carries suffixes over the 50-char header limit. Keep
  // the suffix "free" here too by validating the base, then append it ourselves —
  // `gh pr merge --subject` otherwise drops GitHub's automatic reference.
  const baseSubject = stripPrNumberSuffix(subject);
  validateCommitSubject(rootDir, baseSubject);
  const finalSubject = appendPrNumberSuffix(baseSubject, pr.prNumber);
  assertGuardPair(expectedHeadSha, expectedBaseSha);

  if (
    expectedHeadSha !== undefined &&
    expectedHeadSha.length > 0 &&
    expectedBaseSha !== undefined &&
    expectedBaseSha.length > 0
  ) {
    return guardedReviewedMerge(
      pr,
      finalSubject,
      expectedHeadSha,
      expectedBaseSha,
    );
  }

  const result = spawnSync(
    "gh",
    buildSquashMergeArgs(pr, finalSubject, expectedHeadSha),
    { stdio: "inherit" },
  );
  const exitCode = spawnExitCode("gh pr merge", result);
  if (exitCode !== 0) {
    return exitCode;
  }

  // `gh pr merge` can exit 0 after only queuing the PR (merge queue / auto-merge),
  // where the queue also picks the method. Confirm the squash actually landed.
  const state = prState(pr.prNumber, pr.repo);
  if (state !== "MERGED") {
    process.stderr.write(
      `PR #${pr.prNumber} is not merged (state: ${state || "unknown"}). ` +
        "It may be queued or blocked; the subject-only squash is not guaranteed.\n",
    );
    return 1;
  }

  return 0;
}
