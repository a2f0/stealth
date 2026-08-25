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

/** Refuse to use a direct atomic push to bypass GitHub's PR requirements. */
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

/** Build a squash commit with the reviewed base as its sole parent. */
export function buildReviewedCommitArgs(
  treeSha: string,
  expectedBaseSha: string,
): string[] {
  return ["commit-tree", treeSha, "-p", expectedBaseSha];
}

/**
 * Build an exact compare-and-swap push. Both leases are checked by the remote
 * as one atomic transaction, closing races on either reviewed ref.
 */
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
): { exitCode: number; mergeCommitSha: string } {
  const localHead = run("git", ["rev-parse", "--verify", "HEAD^{commit}"]);
  assertExpectedHeadCommit(expectedHeadSha, localHead);
  const treeSha = run("git", [
    "rev-parse",
    "--verify",
    `${expectedHeadSha}^{tree}`,
  ]);
  const result = spawnSync(
    "git",
    buildReviewedCommitArgs(treeSha, expectedBaseSha),
    {
      input: `${finalSubject}\n`,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  const exitCode = spawnExitCode("git commit-tree", result);
  return { exitCode, mergeCommitSha: result.stdout?.trim() ?? "" };
}

/**
 * Squash the reviewed graph with a server-side compare-and-swap on both refs.
 * Moving the feature ref to the same one-parent commit as the base keeps the
 * PR head reachable (so GitHub marks the PR merged) without turning the squash
 * into a merge commit. This is used whenever ship-pr supplies both guards.
 */
function atomicReviewedMerge(
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
  if (pr.headRefName.length === 0 || pr.headRepository.length === 0) {
    throw new Error("Could not determine the PR head branch and repository.");
  }
  if (pr.headRepository !== pr.repo) {
    throw new Error(
      "Guarded atomic merges require the PR head and base to be in the same repository.",
    );
  }

  // Fetch from the PR's repository and require that it still agrees with the
  // GitHub PR snapshot. The later lease remains the atomic race-closing gate.
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

  const { exitCode, mergeCommitSha } = createReviewedMergeCommit(
    finalSubject,
    expectedHeadSha,
    expectedBaseSha,
  );
  if (exitCode !== 0) return exitCode;
  if (!/^[0-9a-f]{40,64}$/.test(mergeCommitSha)) {
    process.stderr.write("git commit-tree did not return a commit SHA.\n");
    return 1;
  }

  // Refresh immediately before the ref transaction. This explicitly enforces
  // draft, review, mergeability, and required-status policy even when the
  // authenticated account could bypass those protections with a direct push.
  const freshPr = resolvePr();
  assertSameMergeTarget(pr, freshPr);
  assertExpectedHeadCommit(expectedHeadSha, freshPr.headRefOid);
  assertExpectedBaseCommit(expectedBaseSha, freshPr.baseRefOid);
  assertMergeRequirements(freshPr);

  const pushResult = spawnSync(
    "git",
    buildAtomicPushArgs(
      repositoryHttpsUrl(freshPr.repo),
      mergeCommitSha,
      freshPr.baseRefName,
      expectedBaseSha,
      freshPr.headRefName,
      expectedHeadSha,
    ),
    { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdio: "inherit" },
  );
  const pushExitCode = spawnExitCode("atomic reviewed merge push", pushResult);
  if (pushExitCode !== 0) return pushExitCode;

  const state = prState(pr.prNumber, pr.repo);
  if (state !== "MERGED") {
    process.stderr.write(
      `Reviewed merge landed, but PR #${pr.prNumber} is not marked merged (state: ${state || "unknown"}).\n`,
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
 * the guarded path creates an integration commit from that exact pair and
 * compare-and-swap updates the remote base. Without guards, the compatibility
 * path uses GitHub's ordinary squash merge.
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
    return atomicReviewedMerge(
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
