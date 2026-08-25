import { execFileSync, spawnSync } from "node:child_process";

export interface PrIdentity {
  readonly branch: string;
  readonly repo: string;
  readonly prNumber: string;
  readonly title: string;
}

export interface PrMergeIdentity extends PrIdentity {
  readonly baseRefName: string;
  readonly baseRefOid: string;
  readonly headRefName: string;
  readonly headRefOid: string;
  readonly headRepository: string;
  readonly isDraft: boolean;
  readonly mergeable: string;
  readonly mergeStateStatus: string;
  readonly reviewDecision: string;
}

export interface PrContext extends PrIdentity {
  readonly baseRef: string;
}

interface PrView extends PrMergeIdentity {}

interface SpawnResult {
  readonly status: number | null;
  readonly signal: string | null;
  readonly error?: Error;
}

// Large diffs blow past execFileSync's default 1 MiB maxBuffer and throw
// ENOBUFS before we can hand the diff to a reviewer, so capture generously.
export const MAX_BUFFER_BYTES = 512 * 1024 * 1024;

export function run(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: MAX_BUFFER_BYTES,
  }).trim();
}

function tryRun(command: string, args: string[]): string | null {
  try {
    return run(command, args);
  } catch {
    return null;
  }
}

function safeParse(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    return undefined;
  }
}

function fieldOf(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;
}

function stringField(source: string, key: string): string {
  const value = fieldOf(safeParse(source), key);
  return typeof value === "string" ? value : "";
}

function booleanField(source: string, key: string): boolean {
  return fieldOf(safeParse(source), key) === true;
}

function nestedStringField(
  source: string,
  parent: string,
  key: string,
): string {
  const value = fieldOf(fieldOf(safeParse(source), parent), key);
  return typeof value === "string" ? value : "";
}

export function selectOpenPrNumber(
  source: string,
  pushRepository: string,
): string {
  const parsed = safeParse(source);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return "";
  }
  if (pushRepository.length === 0) {
    throw new Error(
      "Could not determine the branch's GitHub push repository, so a same-named fork PR cannot be selected safely.",
    );
  }
  const matching = parsed.filter((candidate) => {
    const headRepository = fieldOf(candidate, "headRepository");
    return fieldOf(headRepository, "nameWithOwner") === pushRepository;
  });
  if (matching.length === 0) {
    return "";
  }
  if (matching.length !== 1) {
    throw new Error(
      `Found ${matching.length} open PRs from '${pushRepository}' for the same branch; select the PR explicitly.`,
    );
  }
  const numberField = fieldOf(matching[0], "number");
  if (typeof numberField !== "number") {
    throw new Error("The matching PR did not include a valid number.");
  }
  return String(numberField);
}

function configuredPushRemote(branch: string): string {
  for (const args of [
    ["config", "--get", `branch.${branch}.pushRemote`],
    ["config", "--get", "remote.pushDefault"],
    ["config", "--get", `branch.${branch}.remote`],
  ]) {
    const remote = tryRun("git", args);
    if (remote !== null && remote.length > 0) return remote;
  }
  const remotes = run("git", ["remote"])
    .split("\n")
    .filter((remote) => remote.length > 0);
  if (remotes.includes("origin")) return "origin";
  return remotes.length === 1 ? (remotes[0] ?? "") : "";
}

/** GitHub `owner/name` for the remote that an ordinary push would target. */
export function resolvePushRepository(branch: string): string {
  const remote = configuredPushRemote(branch);
  if (remote.length === 0 || remote === ".") return "";
  const pushUrl = tryRun("git", ["remote", "get-url", "--push", remote]);
  if (pushUrl === null || pushUrl.length === 0) return "";
  const repositoryRaw = tryRun("gh", [
    "repo",
    "view",
    pushUrl,
    "--json",
    "nameWithOwner",
  ]);
  return repositoryRaw === null
    ? ""
    : stringField(repositoryRaw, "nameWithOwner");
}

/**
 * Base ref for a review, resolved to the *current* remote base. A branch cut from
 * an older base than the local ref would otherwise diff in upstream commits it
 * never authored — so a review (or a repair round) could flag or touch code the
 * branch does not own. Fetch first, require that fetch to succeed, and use the
 * fetched commit itself: narrow fetch refspecs are allowed to update only
 * FETCH_HEAD without moving an origin/* remote-tracking ref.
 */
export function resolveFreshBaseRef(
  repository: string,
  baseRefName: string,
  expectedOid = "",
): string {
  const repositoryRaw = run("gh", [
    "repo",
    "view",
    repository,
    "--json",
    "url",
  ]);
  const repositoryUrl = stringField(repositoryRaw, "url");
  if (repositoryUrl.length === 0) {
    throw new Error(`Could not resolve a fetch URL for '${repository}'.`);
  }
  const fetchResult = spawnSync(
    "git",
    ["fetch", "--quiet", repositoryUrl, baseRefName],
    {
      stdio: "ignore",
    },
  );
  assertSpawnSucceeded(
    `git fetch ${repositoryUrl} ${baseRefName}`,
    fetchResult,
  );
  let fetchedOid: string;
  try {
    fetchedOid = run("git", ["rev-parse", "--verify", "FETCH_HEAD^{commit}"]);
  } catch {
    throw new Error(
      `Could not resolve the commit fetched for base ref '${baseRefName}'.`,
    );
  }
  assertFetchedCommit(baseRefName, expectedOid, fetchedOid);
  return fetchedOid;
}

export function assertFetchedCommit(
  baseRefName: string,
  expectedOid: string,
  fetchedOid: string,
) {
  if (expectedOid.length > 0 && fetchedOid !== expectedOid) {
    throw new Error(
      `Fetched base '${baseRefName}' at ${fetchedOid}, but GitHub reported ${expectedOid}. Retry with a fresh PR snapshot.`,
    );
  }
}

export function assertCleanReviewWorktree(status: string) {
  if (status.trim().length > 0) {
    throw new Error(
      "Review worktree is not clean. Commit intended and untracked files before reviewing.",
    );
  }
}

export function assertSpawnSucceeded(
  command: string,
  result: SpawnResult,
): void {
  if (result.error) {
    throw new Error(`Failed to run ${command}: ${result.error.message}`);
  }
  if (result.signal !== null) {
    throw new Error(`${command} terminated by signal ${result.signal}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} exited with code ${result.status ?? "unknown"}`,
    );
  }
}

export function ensureChanges(baseRef: string): void {
  const result = spawnSync("git", ["diff", "--quiet", `${baseRef}...HEAD`], {
    stdio: "ignore",
  });
  if (result.error) {
    throw result.error;
  }
  // `git diff --quiet` exits 0 (no changes), 1 (changes), or >1 on error.
  if (result.status === 0) {
    throw new Error(`No changes found between ${baseRef} and current branch.`);
  }
  if (result.status !== 1) {
    const detail =
      result.status === null ? "on a signal" : `code ${result.status}`;
    throw new Error(
      `Could not diff against base ref '${baseRef}' (git exited ${detail}).`,
    );
  }
}

/**
 * Map a spawnSync result to a process exit code. A failure to launch (missing
 * binary) or a signal termination leaves `status` null; treat those as a
 * nonzero exit so callers can detect the failure and fall back.
 */
export function spawnExitCode(command: string, result: SpawnResult): number {
  if (result.error) {
    process.stderr.write(`Failed to run ${command}: ${result.error.message}\n`);
    return 1;
  }
  if (result.signal !== null) {
    process.stderr.write(`${command} terminated by signal ${result.signal}\n`);
    return 1;
  }
  return result.status ?? 1;
}

function defaultBranchName(source: string): string {
  const ref = fieldOf(safeParse(source), "defaultBranchRef");
  const name = fieldOf(ref, "name");
  return typeof name === "string" ? name : "";
}

/**
 * Resolve the current git branch, GitHub repo, and the repo's default branch.
 * Throws when on the default branch (or a conventional `main`/`master`) or when
 * the repo can't be determined (gh not authenticated).
 */
export function resolveRepoContext(): {
  branch: string;
  repo: string;
  defaultBranch: string;
} {
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);

  const infoRaw = tryRun("gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner,defaultBranchRef",
  ]);
  const repo = infoRaw === null ? "" : stringField(infoRaw, "nameWithOwner");
  if (repo.length === 0) {
    throw new Error(
      "Could not determine repository. Ensure gh is authenticated.",
    );
  }
  const defaultBranch = infoRaw === null ? "" : defaultBranchName(infoRaw);

  if (branch === defaultBranch || branch === "main" || branch === "master") {
    throw new Error(
      `Cannot run this on the default branch ('${branch}'). Checkout a feature branch first.`,
    );
  }

  return { branch, repo, defaultBranch };
}

/**
 * Number of the open PR for `branch`, or "" when the query **succeeded** and
 * found none. A failed `gh` call (auth, rate limit, network) throws rather than
 * reporting "" — callers use the empty string to mean "no PR yet" and would
 * otherwise pick the wrong review base or skip a duplicate-PR guard on a
 * transient failure.
 */
export function findOpenPrNumber(branch: string, repo: string): string {
  const raw = tryRun("gh", [
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "open",
    "--json",
    "number,headRepository",
    "-R",
    repo,
  ]);
  if (raw === null) {
    throw new Error(
      `Could not list open PRs for branch '${branch}'. Ensure gh is authenticated and reachable.`,
    );
  }
  return selectOpenPrNumber(raw, resolvePushRepository(branch));
}

/** Read a known-open PR's title and base identity from GitHub. */
function viewPr(branch: string, repo: string, prNumber: string): PrView {
  const viewRaw = run("gh", [
    "pr",
    "view",
    prNumber,
    "--json",
    "title,baseRefName,baseRefOid,headRefName,headRefOid,headRepository,isDraft,mergeable,mergeStateStatus,reviewDecision",
    "-R",
    repo,
  ]);

  return {
    branch,
    repo,
    prNumber,
    title: stringField(viewRaw, "title"),
    baseRefName: stringField(viewRaw, "baseRefName"),
    baseRefOid: stringField(viewRaw, "baseRefOid"),
    headRefName: stringField(viewRaw, "headRefName"),
    headRefOid: stringField(viewRaw, "headRefOid"),
    headRepository: nestedStringField(
      viewRaw,
      "headRepository",
      "nameWithOwner",
    ),
    isDraft: booleanField(viewRaw, "isDraft"),
    mergeable: stringField(viewRaw, "mergeable"),
    mergeStateStatus: stringField(viewRaw, "mergeStateStatus"),
    reviewDecision: stringField(viewRaw, "reviewDecision"),
  };
}

/**
 * Resolve the open PR for the current branch from git + GitHub. Throws with an
 * actionable message when there is nothing reviewable (on main, no PR, gh not
 * authenticated).
 */
function fetchPrView(): PrView {
  const { branch, repo } = resolveRepoContext();

  const prNumber = findOpenPrNumber(branch, repo);
  if (prNumber.length === 0) {
    throw new Error(`No PR found for branch '${branch}'. Create a PR first.`);
  }

  return viewPr(branch, repo, prNumber);
}

/** Current GitHub state of a PR (e.g. "OPEN", "MERGED", "CLOSED"). */
export function prState(prNumber: string, repo: string): string {
  return stringField(
    run("gh", ["pr", "view", prNumber, "--json", "state", "-R", repo]),
    "state",
  );
}

/** Identity of the open PR for the current branch (no base-ref resolution). */
export function resolvePr(): PrMergeIdentity {
  const view = fetchPrView();
  return {
    branch: view.branch,
    repo: view.repo,
    prNumber: view.prNumber,
    title: view.title,
    baseRefName: view.baseRefName,
    baseRefOid: view.baseRefOid,
    headRefName: view.headRefName,
    headRefOid: view.headRefOid,
    headRepository: view.headRepository,
    isDraft: view.isDraft,
    mergeable: view.mergeable,
    mergeStateStatus: view.mergeStateStatus,
    reviewDecision: view.reviewDecision,
  };
}

/**
 * PR identity plus a base ref that `git diff` can resolve locally, for a review
 * that may run *before* the branch has a PR.
 *
 * When an open PR exists this matches what a post-open review would see: the
 * base ref is the PR's own base, resolved to its current remote tip. When none
 * exists yet, `prNumber`/`title` are empty and the base ref is the repository's
 * current default branch — so the identical `base...HEAD` diff can be reviewed on
 * the local branch now and reviewed again once its PR is open. Either way the base
 * is fetched fresh, so a stale local ref never leaks upstream commits into the
 * diff. Throws on the default branch, via `resolveRepoContext`.
 */
export function resolveReviewContext(): PrContext {
  const { branch, repo, defaultBranch } = resolveRepoContext();
  assertCleanReviewWorktree(
    run("git", ["status", "--porcelain", "--untracked-files=all"]),
  );

  const prNumber = findOpenPrNumber(branch, repo);
  if (prNumber.length === 0) {
    if (defaultBranch.length === 0) {
      throw new Error(
        "Could not determine the repository default branch to review against.",
      );
    }
    // No PR yet: review the local branch against the *current* remote default,
    // fetched fresh so a stale local ref cannot pull unrelated upstream commits
    // into the diff.
    return {
      branch,
      repo,
      prNumber: "",
      title: "",
      baseRef: resolveFreshBaseRef(repo, defaultBranch),
    };
  }

  const view = viewPr(branch, repo, prNumber);
  if (view.baseRefName.length === 0) {
    throw new Error("Could not determine base branch from GitHub.");
  }
  return {
    branch,
    repo,
    prNumber,
    title: view.title,
    baseRef: resolveFreshBaseRef(repo, view.baseRefName, view.baseRefOid),
  };
}
