import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ensureChanges,
  MAX_BUFFER_BYTES,
  resolveReviewContext,
  run,
  spawnExitCode,
} from "../git/prContext";
import { materializeTrackedCheckout } from "./materializeTrackedCheckout";
import {
  DEFAULT_CODEX_EFFORT,
  type ReviewEffort,
  resolveReviewEffort,
} from "./reviewEffort";
import {
  buildReviewPrompt,
  CODEX_ACCESS_NOTE,
  readReviewInstructions,
} from "./reviewPrompt";
import { type ReviewerEnv, relayReviewWithRetry } from "./runReview";

/** How much transcript tail to relay when a codex attempt fails outright. */
const TRANSCRIPT_TAIL_CHARS = 2000;

const REVIEWER_ENV_ALLOWLIST = new Set([
  "ALL_PROXY",
  "CODEX_HOME",
  "HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LC_ALL",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "PATH",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "all_proxy",
  "https_proxy",
  "http_proxy",
  "no_proxy",
]);

const REVIEWER_SHELL_PATH =
  "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin";

/** Keep only values the Codex process may need for auth and transport. */
export function reviewerEnvironment(env: ReviewerEnv): ReviewerEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key, value]) => REVIEWER_ENV_ALLOWLIST.has(key) && value !== undefined,
    ),
  );
}

/** Resolve the command path and symlink target the sandbox helper must execute. */
export function reviewerRuntimePaths(env: ReviewerEnv): string[] {
  const searchPath = env.PATH ?? "";
  for (const directory of searchPath.split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, "codex");
    try {
      accessSync(candidate, constants.X_OK);
      return [...new Set([candidate, realpathSync(candidate)])];
    } catch {
      // Keep searching PATH for an executable Codex installation.
    }
  }
  return [];
}

function reviewerFilesystemConfig(runtimePaths: readonly string[]): string {
  const runtimeEntries = runtimePaths
    .map((runtimePath) => `${JSON.stringify(runtimePath)}="read"`)
    .join(",");
  const suffix = runtimeEntries.length > 0 ? `,${runtimeEntries}` : "";
  return `permissions.agent-tool-review.filesystem={":minimal"="read",":workspace_roots"={"."="read"}${suffix}}`;
}

/**
 * Build the `codex exec` argv. `exec`, not `review`: `codex review` writes its
 * own prompt, so it carries no verdict line to gate on and interleaves its
 * findings with an investigative transcript. `exec` takes this repo's prompt —
 * the same verdict-gated one Claude reviews under — reading it from stdin
 * (`-`) to dodge argv limits. The sandbox is pinned read-only (the prompt is a
 * PR diff — attacker-influenceable text — and a review needs no writes), the
 * effort is pinned so the review never silently inherits
 * `~/.codex/config.toml`, and the final message is written alone to
 * `lastMessageFile`, so what gets relayed is the review, not the transcript.
 *
 * `--ignore-user-config` keeps the session hermetic. The sandbox confines only
 * model-generated shell commands, so MCP servers configured in
 * `~/.codex/config.toml` would still load and could mutate external state on
 * behalf of that attacker-influenceable diff — and `-c mcp_servers={}` cannot
 * remove them, since table overrides merge instead of replacing (verified
 * against codex 0.145: `codex mcp list` is unchanged under that override).
 * Ignoring the user config drops those servers wholesale; auth still works,
 * and everything the review needs is pinned explicitly right here.
 * `--disable plugins/hooks/apps` closes the remaining gaps: plugin-provided
 * MCP servers, trusted hooks, and app connectors all live outside
 * `config.toml`, so ignoring the config alone would leave them active.
 * The primary workspace is a fresh temporary directory containing a
 * tracked-files-only snapshot. A least-privilege permission profile allows
 * reads only from minimal runtime paths and that temporary workspace, while
 * shell environment inheritance is disabled. Contributor-controlled
 * `AGENTS.md` files are nested data rather than workspace policy, and ignored,
 * untracked, and neighboring files are outside the reviewer's filesystem.
 */
export function buildCodexReviewArgs(
  effort: ReviewEffort,
  lastMessageFile: string,
  reviewRoot: string,
  runtimePaths: readonly string[] = [],
): string[] {
  return [
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--strict-config",
    "--disable",
    "plugins",
    "--disable",
    "hooks",
    "--disable",
    "apps",
    "--cd",
    reviewRoot,
    "--skip-git-repo-check",
    "-c",
    `model_reasoning_effort="${effort}"`,
    "-c",
    'default_permissions="agent-tool-review"',
    "-c",
    reviewerFilesystemConfig(runtimePaths),
    "-c",
    'shell_environment_policy.inherit="none"',
    "-c",
    "shell_environment_policy.experimental_use_profile=false",
    "-c",
    `shell_environment_policy.set={PATH="${REVIEWER_SHELL_PATH}"}`,
    "--color",
    "never",
    "--output-last-message",
    lastMessageFile,
    "-",
  ];
}

/** Content of the last-message file, or "" when codex never wrote one. */
function readLastMessage(lastMessageFile: string): string {
  try {
    return readFileSync(lastMessageFile, "utf8");
  } catch {
    return "";
  }
}

/**
 * Run `codex exec` over an already-built review prompt and relay the final
 * message it writes.
 *
 * The review is read from `--output-last-message`, not the process streams:
 * codex prints its session transcript — including a verbatim echo of the
 * prompt and diff — to stderr and the final message to stdout, and inheriting
 * either would bury the verdict in noise (the exact failure this replaces).
 * Both streams are captured; on a failed launch the stderr tail is relayed so
 * the error is still diagnosable. Degenerate exit-0 output is retried once via
 * the shared gate, same as the Claude path.
 */
export function spawnCodexReview(
  prompt: string,
  effort: ReviewEffort,
  env: ReviewerEnv = process.env,
  repositoryRoot = process.cwd(),
): number {
  const outDir = mkdtempSync(path.join(tmpdir(), "agent-tool-codex-"));
  const checkoutDir = path.join(outDir, "checkout");
  const runtimePaths = reviewerRuntimePaths(env);
  let attempt = 0;
  try {
    materializeTrackedCheckout(repositoryRoot, checkoutDir);
    return relayReviewWithRetry("codex", () => {
      // A fresh file per attempt, so a retry that crashes before writing can
      // never be read as the previous attempt's stale message.
      attempt += 1;
      const lastMessageFile = path.join(outDir, `review-${attempt}.md`);
      const result = spawnSync(
        "codex",
        buildCodexReviewArgs(effort, lastMessageFile, outDir, runtimePaths),
        {
          stdio: ["pipe", "pipe", "pipe"],
          input: prompt,
          encoding: "utf8",
          maxBuffer: MAX_BUFFER_BYTES,
          env: reviewerEnvironment(env),
        },
      );
      const exitCode = spawnExitCode("codex", result);
      const transcript = result.stderr ?? "";
      if (exitCode !== 0 && transcript.length > 0) {
        process.stderr.write(
          `codex transcript (tail):\n${transcript.slice(-TRANSCRIPT_TAIL_CHARS)}\n`,
        );
      }
      return { exitCode, review: readLastMessage(lastMessageFile) };
    });
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

/**
 * Ask the local `codex` CLI to review the current branch's diff. Branch/PR/base
 * are derived from git + GitHub; when the branch has no PR yet the diff is
 * taken against the default branch, so a review can run before the PR is
 * opened. The effort level defaults to `high` for Codex.
 */
export function solicitCodexReview(
  rootDir: string,
  effortArg?: string,
): number {
  const effort = resolveReviewEffort(effortArg, DEFAULT_CODEX_EFFORT);
  const context = resolveReviewContext();
  ensureChanges(context.baseRef);

  const diff = run("git", ["diff", `${context.baseRef}...HEAD`]);
  const prompt = buildReviewPrompt({
    context,
    diff,
    reviewInstructions: readReviewInstructions(rootDir, context.baseRef),
    accessNote: `${CODEX_ACCESS_NOTE}. The committed files are in the tracked checkout/ directory`,
  });

  return spawnCodexReview(prompt, effort, process.env, rootDir);
}
