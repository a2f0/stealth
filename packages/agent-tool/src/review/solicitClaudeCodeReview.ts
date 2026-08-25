import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertSameReviewContext,
  ensureChanges,
  MAX_BUFFER_BYTES,
  resolveReviewContext,
  run,
  spawnExitCode,
} from "../git/prContext";
import { materializeTrackedCheckout } from "./materializeTrackedCheckout";
import {
  DEFAULT_CLAUDE_EFFORT,
  type ReviewEffort,
  resolveReviewEffort,
} from "./reviewEffort";
import {
  buildReviewPrompt,
  CLAUDE_ACCESS_NOTE,
  readReviewInstructions,
} from "./reviewPrompt";
import { type ReviewerEnv, relayReviewWithRetry } from "./runReview";
import {
  resolveTrustedExecutable,
  type TrustedExecutable,
  trustedRuntimePath,
} from "./trustedExecutable";

/**
 * Tools the reviewer gets. Read-only, and deliberately not empty: the diff alone
 * does not show whether a changed line is safe, so the good findings come from
 * reading around it — an unchanged branch further up the file, the source-shape
 * baseline a file has to stay under, the callers a signature change breaks.
 *
 * `Bash` is withheld for two reasons, neither of which is reliability. A review
 * needs no shell, so every Bash call is a turn spent earning a denial (`--print`
 * denies what would need approval, hands the denial back, and carries on). And
 * the session's context is a PR diff — attacker-influenceable text on a public
 * repo — which is not something to hand a shell.
 */
const REVIEW_TOOLS = ["Read", "Grep", "Glob"] as const;

const CLAUDE_ENV_ALLOWLIST = new Set([
  "ALL_PROXY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LC_ALL",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
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

function claudeSandboxEnvironment(
  env: ReviewerEnv,
  codexHome: string,
  executablePath: string,
): ReviewerEnv {
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(
        ([key, value]) => CLAUDE_ENV_ALLOWLIST.has(key) && value !== undefined,
      ),
    ),
    CODEX_HOME: codexHome,
    PATH: executablePath,
  };
}

function claudeFilesystemConfig(runtimePaths: readonly string[]): string {
  const runtimeEntries = runtimePaths
    .map((runtimePath) => `${JSON.stringify(runtimePath)}="read"`)
    .join(",");
  return `permissions.agent-tool-claude-review.filesystem={":minimal"="read",":workspace_roots"={"."="read"},${runtimeEntries}}`;
}

/**
 * Build the `claude` argv for a non-interactive review at the given effort
 * level. The prompt itself goes over stdin, not argv.
 */
export function buildClaudeReviewArgs(effort: ReviewEffort): string[] {
  return [
    "--bare",
    "--safe-mode",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--no-chrome",
    "--effort",
    effort,
    "--print",
    "--tools",
    REVIEW_TOOLS.join(","),
  ];
}

/** Build the outer Codex filesystem sandbox and inner bare Claude invocation. */
export function buildClaudeSandboxArgs(
  effort: ReviewEffort,
  reviewRoot: string,
  runtime: TrustedExecutable,
): string[] {
  return [
    "sandbox",
    "--cd",
    reviewRoot,
    "-c",
    claudeFilesystemConfig(runtime.readablePaths),
    "-c",
    "permissions.agent-tool-claude-review.network.enabled=true",
    "--permission-profile",
    "agent-tool-claude-review",
    "--",
    runtime.executable,
    ...buildClaudeReviewArgs(effort),
  ];
}

/**
 * Run `claude` over an already-built review prompt and relay whatever it says.
 *
 * Returns nonzero both when the CLI fails outright and when it exits 0 having
 * produced something that is not a review — after one retry of the latter, since
 * that failure is stochastic — so a caller's fallback chain treats a degenerate
 * review the same as a crashed one.
 */
export function spawnClaudeReview(
  prompt: string,
  effort: ReviewEffort,
  env: ReviewerEnv = process.env,
  repositoryRoot = process.cwd(),
  headRef = "HEAD",
): number {
  const runtime = resolveTrustedExecutable("claude", env, repositoryRoot);
  if (runtime === null) {
    process.stderr.write(
      "Failed to run claude: no executable outside the repository was found in PATH.\n",
    );
    return 1;
  }
  const codexRuntime = resolveTrustedExecutable("codex", env, repositoryRoot);
  if (codexRuntime === null) {
    process.stderr.write(
      "Failed to run sandboxed claude: no Codex executable outside the repository was found in PATH.\n",
    );
    return 1;
  }

  const outDir = mkdtempSync(path.join(tmpdir(), "agent-tool-claude-"));
  const checkoutDir = path.join(outDir, "checkout");
  const codexHome = path.join(outDir, "codex-home");
  try {
    mkdirSync(codexHome);
    materializeTrackedCheckout(repositoryRoot, checkoutDir, headRef);
    return relayReviewWithRetry("claude", () => {
      // Codex's standalone sandbox supplies the filesystem boundary Claude's
      // Read/Grep/Glob permissions do not. Bare mode prevents keychain/config
      // reads; authentication must arrive through the allowlisted environment.
      const result = spawnSync(
        codexRuntime.executable,
        buildClaudeSandboxArgs(effort, outDir, runtime),
        {
          stdio: ["pipe", "pipe", "inherit"],
          input: prompt,
          encoding: "utf8",
          maxBuffer: MAX_BUFFER_BYTES,
          env: claudeSandboxEnvironment(
            env,
            codexHome,
            trustedRuntimePath([codexRuntime, runtime]),
          ),
        },
      );
      return {
        exitCode: spawnExitCode("sandboxed claude", result),
        review: result.stdout ?? "",
      };
    });
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

/**
 * Ask the local `claude` CLI to review the current branch's diff. Branch/PR/base
 * are derived from git + GitHub; when the branch has no PR yet the diff is taken
 * against the default branch, so a review can run before the PR is opened. The
 * prompt is streamed via stdin (not argv) to avoid "Argument list too long"
 * failures on large PRs. The effort level defaults to `xhigh` for Claude.
 */
export function solicitClaudeCodeReview(
  rootDir: string,
  effortArg?: string,
  expectedBaseRef?: string,
): number {
  const effort = resolveReviewEffort(effortArg, DEFAULT_CLAUDE_EFFORT);
  const context = resolveReviewContext(expectedBaseRef);
  ensureChanges(context.baseRef, context.headRef);

  const diff = run("git", ["diff", `${context.baseRef}...${context.headRef}`]);
  const prompt = buildReviewPrompt({
    context,
    diff,
    reviewInstructions: readReviewInstructions(rootDir, context.baseRef),
    accessNote: `${CLAUDE_ACCESS_NOTE}. The committed files are in the tracked checkout/ directory`,
  });

  const exitCode = spawnClaudeReview(
    prompt,
    effort,
    process.env,
    rootDir,
    context.headRef,
  );
  if (exitCode !== 0) return exitCode;
  assertSameReviewContext(context, resolveReviewContext(context.baseRef));
  return 0;
}
