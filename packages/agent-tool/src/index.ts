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
 *   bumpVersions <base-oid>     Patch-bump each changed versioned package one
 *                               past its version at <base-oid> (prints the
 *                               rewritten package.json paths)
 *   checkVersions <base-oid>    Exit non-zero when a versioned package is not
 *                               at the version bumpVersions would write
 *   resolveVersionConflicts     Finish a base merge whose only conflicts are
 *                               versioned package.json version fields
 */
import { openPr } from "./pr/openPr";
import { squashMerge } from "./pr/squashMerge";
import { runPreflight } from "./process/runPreflight";
import { initializeTrustedTooling } from "./process/trustedTooling";
import { solicitClaudeCodeReview } from "./review/solicitClaudeCodeReview";
import { solicitCodexReview } from "./review/solicitCodexReview";
import { bumpVersions, checkVersions } from "./version/bumpVersions";
import { resolveVersionConflicts } from "./version/resolveVersionConflicts";

const USAGE =
  "Usage: agent-tool <solicitClaudeCodeReview|solicitCodexReview|openPr|runPreflight|squashMerge|bumpVersions|checkVersions|resolveVersionConflicts> [args]\n";

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
    case "bumpVersions":
      return bumpVersions(rootDir, process.argv[3]);
    case "checkVersions":
      return checkVersions(rootDir, process.argv[3]);
    case "resolveVersionConflicts":
      return resolveVersionConflicts(rootDir);
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
