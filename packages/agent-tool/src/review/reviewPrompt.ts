import { execFileSync } from "node:child_process";

import type { PrContext } from "../git/prContext";
import { toolEnvironment, toolExecutable } from "../process/trustedTooling";
import { REVIEW_VERDICTS } from "./reviewOutput";

const REVIEW_INSTRUCTION_FILES = ["REVIEW.md", "AGENTS.md"];

/**
 * Per-agent line telling the reviewer how it may inspect the repo. The rest of
 * the prompt is shared, but this line cannot be: Claude reviews with read-only
 * tools and no shell, while Codex reads the repo *through* its shell — telling
 * Codex "you cannot run commands" would talk it out of reading files at all.
 */
export const CLAUDE_ACCESS_NOTE =
  "Read the surrounding files when a finding depends on code the diff does not show; you have Read, Grep, and Glob for that. You cannot run commands, so do not plan to build, typecheck, or execute tests";
export const CODEX_ACCESS_NOTE =
  "Read the surrounding files when a finding depends on code the diff does not show; your sandbox is read-only, so use read-only commands and do not attempt to build, typecheck, or execute tests";

export function buildReviewPrompt(params: {
  context: PrContext;
  diff: string;
  reviewInstructions: string;
  accessNote: string;
}): string {
  const { context, diff, reviewInstructions, accessNote } = params;
  // The review can run before the branch has a PR, in which case there is no
  // number to show — say so rather than printing a bare `PR: #`.
  const prLine =
    context.prNumber.length > 0
      ? `PR: #${context.prNumber}`
      : "PR: (not opened yet)";
  return `Review this PR diff using the project's review guidelines. Be concise and actionable.

## Review Guidelines
${reviewInstructions}

## PR Context
Branch: ${context.branch}
${prLine}
Base: ${context.baseRef}
Head: ${context.headRef}

## Diff
${diff}

## Instructions
- The full diff is above. ${accessNote}
- Flag security issues, type safety violations, and missing tests as high priority
- Use severity levels: Blocker, Major, Minor, Suggestion
- Be concise: one line per issue with file:line reference
- Output your review to stdout
- End with a verdict on its own line — \`VERDICT: X\` where X is ${REVIEW_VERDICTS.join(", ")} — naming the highest severity you found, or CLEAN when the diff needs no changes. Output with no verdict line is discarded and the review is retried with another agent.`;
}

type ReadAtRef = (rootDir: string, ref: string, filename: string) => string;

function gitShow(rootDir: string, ref: string, filename: string): string {
  return execFileSync(
    toolExecutable("git"),
    ["-C", rootDir, "show", `${ref}:${filename}`],
    {
      encoding: "utf8",
      env: toolEnvironment(),
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
}

/** Load review policy from the fetched base commit, never the untrusted branch. */
export function readReviewInstructions(
  rootDir: string,
  baseRef: string,
  readAtRef: ReadAtRef = gitShow,
): string {
  for (const candidate of REVIEW_INSTRUCTION_FILES) {
    try {
      return readAtRef(rootDir, baseRef, candidate);
    } catch {
      // The policy filename is optional; try the next trusted candidate.
    }
  }
  return "";
}
