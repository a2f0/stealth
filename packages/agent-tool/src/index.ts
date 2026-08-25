#!/usr/bin/env bun
/**
 * agent-tool - minimal CLI for cross-agent code review and PR workflows.
 *
 * Usage: bun packages/agent-tool/src/index.ts <action> [args]
 *   solicitClaudeCodeReview [effort] [base-sha]
 *                               Review the current branch's diff with the local
 *                               `claude` CLI — against the PR base, or the
 *                               default branch when no PR is open yet (effort
 *                               defaults to xhigh)
 *   solicitCodexReview [effort] [base-sha]
 *                               Review the current branch's diff with the local
 *                               `codex` CLI — against the PR base, or the default
 *                               branch when no PR is open yet (effort defaults to
 *                               high)
 *
 *   effort levels: low | medium | high | xhigh | max
 *   openPr [title]              Open a PR for the current branch with a
 *                               commitlint-valid title (body from stdin)
 *   runPreflight <script> [...args]
 *                               Run a package script without credentials or
 *                               external network access in a bounded sandbox
 *   squashMerge [subject] [head-sha] [base-sha]
 *                               Squash-merge the current PR with a subject-only
 *                               commit (defaults to the PR title), appending the
 *                               `(#<pr>)` reference to the subject. Optional
 *                               [head-sha] binds the merge to that head via
 *                               `--match-head-commit`; [base-sha] rejects a
 *                               base that moved after review.
 */
import { openPr } from "./pr/openPr";
import { squashMerge } from "./pr/squashMerge";
import { runPreflight } from "./process/runPreflight";
import { initializeTrustedTooling } from "./process/trustedTooling";
import { solicitClaudeCodeReview } from "./review/solicitClaudeCodeReview";
import { solicitCodexReview } from "./review/solicitCodexReview";

const USAGE =
  "Usage: agent-tool <solicitClaudeCodeReview|solicitCodexReview|openPr|runPreflight|squashMerge> [args]\n";

function main(): number {
  const action = process.argv[2];
  const rootDir = initializeTrustedTooling();
  process.chdir(rootDir);

  switch (action) {
    case "solicitClaudeCodeReview":
      return solicitClaudeCodeReview(rootDir, process.argv[3], process.argv[4]);
    case "solicitCodexReview":
      return solicitCodexReview(rootDir, process.argv[3], process.argv[4]);
    case "openPr":
      return openPr(rootDir, process.argv[3]);
    case "runPreflight":
      return runPreflight(rootDir, process.argv[3], process.argv.slice(4));
    case "squashMerge":
      return squashMerge(
        rootDir,
        process.argv[3],
        process.argv[4],
        process.argv[5],
      );
    default:
      process.stderr.write(`Unknown action: ${action ?? "(none)"}\n${USAGE}`);
      return 1;
  }
}

try {
  process.exit(main());
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}
