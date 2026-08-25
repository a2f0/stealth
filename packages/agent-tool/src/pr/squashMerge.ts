import { spawnSync } from "node:child_process";

import {
  type PrMergeIdentity,
  prState,
  repositoryHttpsUrl,
  resolveFreshBaseRef,
  resolvePr,
  run,
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
  enableAutoMerge = true,
): string[] {
  const args = [
    "pr",
    "merge",
    pr.prNumber,
    "--squash",
    ...(enableAutoMerge ? ["--auto"] : []),
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
  if (pr.mergeable === "CONFLICTING") {
    throw new Error("GitHub reports that the PR has merge conflicts.");
  }
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    throw new Error("The PR has unresolved requested changes.");
  }
}

export function assertImmediatelyMergeable(pr: PrMergeIdentity): void {
  assertMergeRequirements(pr);
  if (
    pr.mergeable !== "MERGEABLE" ||
    pr.mergeStateStatus !== "CLEAN" ||
    pr.reviewDecision === "REVIEW_REQUIRED"
  ) {
    throw new Error(
      `The guarded GitHub merge must be immediately mergeable without auto-merge (mergeable: ${pr.mergeable || "UNKNOWN"}; state: ${pr.mergeStateStatus || "UNKNOWN"}; review: ${pr.reviewDecision || "NONE"}). Wait for policy requirements, then re-review the unchanged head/base pair.`,
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

type GuardedMergeStrategy = "atomic_refs" | "github_api";

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function fieldOf(value: unknown, key: string): unknown {
  return recordOf(value)?.[key];
}

/** Select a base-race-safe strategy from GitHub's effective branch policy. */
export function selectGuardedMergeStrategy(
  classicProtection: unknown,
  rules: unknown,
): GuardedMergeStrategy {
  const ruleList = Array.isArray(rules) ? rules : [];
  if (
    ruleList.some((candidate) => fieldOf(candidate, "type") === "merge_queue")
  ) {
    throw new Error(
      "Guarded merging does not support an active merge queue because its merge-group commit and configured merge method are not the reviewed head/base pair.",
    );
  }
  if (classicProtection === null && ruleList.length === 0) {
    // With no branch policy to bypass, an atomic two-ref lease is the complete
    // server-side guard for both reviewed commits.
    return "atomic_refs";
  }

  const requiredChecks = recordOf(
    fieldOf(classicProtection, "required_status_checks"),
  );
  const classicStrict = fieldOf(requiredChecks, "strict") === true;
  const rulesetStrict = ruleList.some((candidate) => {
    const parameters = recordOf(fieldOf(candidate, "parameters"));
    const ruleType = fieldOf(candidate, "type");
    return (
      ruleType === "required_status_checks" &&
      fieldOf(parameters, "strict_required_status_checks_policy") === true
    );
  });
  if (classicStrict || rulesetStrict) return "github_api";
  throw new Error(
    "The base branch has merge policy but does not require branches to be up to date. Enable strict status checks before guarded merging; merge queues require review of the actual merge group and are not supported.",
  );
}

function githubApiJson(path: string, allowUnprotected = false): unknown {
  const result = spawnSync("gh", ["api", path], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  const stderr = result.stderr ?? "";
  if (
    allowUnprotected &&
    result.status === 1 &&
    /Branch not protected.*HTTP 404/i.test(stderr)
  ) {
    return null;
  }
  if (result.status !== 0) {
    throw new Error(
      `gh api ${path} failed (${result.status ?? "signal"}): ${stderr.trim()}`,
    );
  }
  try {
    return JSON.parse(result.stdout ?? "");
  } catch {
    throw new Error(`gh api ${path} returned invalid JSON.`);
  }
}

function resolveGuardedMergeStrategy(
  repo: string,
  branch: string,
): GuardedMergeStrategy {
  const encodedBranch = encodeURIComponent(branch);
  const protection = githubApiJson(
    `repos/${repo}/branches/${encodedBranch}/protection`,
    true,
  );
  const rules = githubApiJson(`repos/${repo}/rules/branches/${encodedBranch}`);
  return selectGuardedMergeStrategy(protection, rules);
}

/** Build a one-parent squash commit from the exact reviewed tree and base. */
export function buildReviewedCommitArgs(
  treeSha: string,
  expectedBaseSha: string,
): string[] {
  return ["commit-tree", treeSha, "-p", expectedBaseSha];
}

/** Build an atomic compare-and-swap update for both reviewed refs. */
export function buildAtomicPushArgs(
  repositoryUrl: string,
  mergeCommitSha: string,
  baseRefName: string,
  expectedBaseSha: string,
  headRefName: string,
  expectedHeadSha: string,
): string[] {
  const baseRef = `refs/heads/${baseRefName}`;
  const headRef = `refs/heads/${headRefName}`;
  return [
    "-c",
    "credential.helper=",
    "-c",
    "credential.helper=!gh auth git-credential",
    "push",
    "--porcelain",
    "--atomic",
    `--force-with-lease=${baseRef}:${expectedBaseSha}`,
    `--force-with-lease=${headRef}:${expectedHeadSha}`,
    repositoryUrl,
    `${mergeCommitSha}:${baseRef}`,
    `${mergeCommitSha}:${headRef}`,
  ];
}

function createReviewedMergeCommit(
  finalSubject: string,
  expectedHeadSha: string,
  expectedBaseSha: string,
): string {
  const localHead = run("git", ["rev-parse", "--verify", "HEAD^{commit}"]);
  assertExpectedHeadCommit(expectedHeadSha, localHead);
  const treeSha = run("git", [
    "rev-parse",
    "--verify",
    `${expectedHeadSha}^{tree}`,
  ]);
  return run("git", [
    ...buildReviewedCommitArgs(treeSha, expectedBaseSha),
    "-m",
    finalSubject,
  ]);
}

function atomicReviewedMerge(
  pr: PrMergeIdentity,
  finalSubject: string,
  expectedHeadSha: string,
  expectedBaseSha: string,
): number {
  if (pr.headRepository !== pr.repo) {
    throw new Error(
      "An unprotected fork PR cannot atomically update refs in two repositories.",
    );
  }
  const mergeCommitSha = createReviewedMergeCommit(
    finalSubject,
    expectedHeadSha,
    expectedBaseSha,
  );
  const result = spawnSync(
    "git",
    buildAtomicPushArgs(
      repositoryHttpsUrl(pr.repo),
      mergeCommitSha,
      pr.baseRefName,
      expectedBaseSha,
      pr.headRefName,
      expectedHeadSha,
    ),
    { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdio: "inherit" },
  );
  return spawnExitCode("atomic reviewed merge push", result);
}

export function mergeStateExitCode(state: string): number | null {
  if (state === "MERGED") return 0;
  if (state === "CLOSED") return 1;
  return null;
}

const mergeWaitTimeoutMilliseconds = 10 * 60 * 1000;

export function mergeWaitExitCode(
  state: string,
  elapsedMilliseconds: number,
  timeoutMilliseconds = mergeWaitTimeoutMilliseconds,
): number | null {
  return (
    mergeStateExitCode(state) ??
    (elapsedMilliseconds >= timeoutMilliseconds ? 2 : null)
  );
}

function waitForMergedPr(prNumber: string, repo: string): number {
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  const startedAt = Date.now();
  let polls = 0;
  while (true) {
    if (mergeWaitExitCode("", Date.now() - startedAt) === 2) {
      process.stderr.write(
        `PR #${prNumber} is still pending after 10 minutes. Its auto-merge or queue entry may remain active; do not clean up the branch until GitHub reports MERGED.\n`,
      );
      return 2;
    }
    let state: string;
    try {
      state = prState(prNumber, repo);
    } catch (cause) {
      process.stderr.write(
        `Could not refresh PR #${prNumber} while waiting for its merge; retrying: ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
      Atomics.wait(waitBuffer, 0, 0, 5_000);
      continue;
    }
    const exitCode = mergeStateExitCode(state);
    if (exitCode !== null) {
      if (exitCode !== 0) {
        process.stderr.write(
          `PR #${prNumber} closed without reaching MERGED.\n`,
        );
      }
      return exitCode;
    }
    polls += 1;
    if (polls === 1 || polls % 12 === 0) {
      process.stderr.write(
        `PR #${prNumber} is ${state || "pending"}; waiting for the active merge or queue entry.\n`,
      );
    }
    Atomics.wait(waitBuffer, 0, 0, 5_000);
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

  const strategy = resolveGuardedMergeStrategy(
    freshPr.repo,
    freshPr.baseRefName,
  );
  if (strategy === "github_api") assertImmediatelyMergeable(freshPr);
  const mergeExitCode =
    strategy === "atomic_refs"
      ? atomicReviewedMerge(
          freshPr,
          finalSubject,
          expectedHeadSha,
          expectedBaseSha,
        )
      : spawnExitCode(
          "gh pr merge",
          spawnSync(
            "gh",
            buildSquashMergeArgs(freshPr, finalSubject, expectedHeadSha, false),
            { stdio: "inherit" },
          ),
        );
  if (mergeExitCode !== 0) return mergeExitCode;

  return waitForMergedPr(pr.prNumber, pr.repo);
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

  // `gh pr merge` can enqueue rather than immediately merge. Do not return a
  // failure while that active mutation can still land after cleanup was skipped.
  return waitForMergedPr(pr.prNumber, pr.repo);
}
