import { describe, expect, test } from "bun:test";

import { REVIEW_VERDICTS } from "./reviewOutput";
import {
  buildReviewPrompt,
  CLAUDE_ACCESS_NOTE,
  CODEX_ACCESS_NOTE,
  readReviewInstructions,
} from "./reviewPrompt";

describe("buildReviewPrompt", () => {
  const context = {
    branch: "feat/example",
    repo: "owner/repo",
    prNumber: "42",
    title: "feat: example change",
    baseRef: "main",
    headRef: "head-1",
  };

  /** Shared params; tests override what they exercise. */
  const params = {
    context,
    diff: "diff --git a/x.ts b/x.ts",
    reviewInstructions: "PROJECT GUIDELINES",
    accessNote: CLAUDE_ACCESS_NOTE,
  };

  test("embeds PR context, guidelines, and diff", () => {
    const prompt = buildReviewPrompt(params);

    expect(prompt).toContain("Branch: feat/example");
    expect(prompt).toContain("PR: #42");
    expect(prompt).toContain("Base: main");
    expect(prompt).toContain("Head: head-1");
    expect(prompt).toContain("PROJECT GUIDELINES");
    expect(prompt).toContain("diff --git a/x.ts b/x.ts");
  });

  test("names the PR as not opened yet when there is no PR number", () => {
    const prompt = buildReviewPrompt({
      ...params,
      context: { ...context, prNumber: "", title: "" },
    });

    expect(prompt).toContain("PR: (not opened yet)");
    expect(prompt).not.toContain("PR: #");
  });

  test("demands a verdict line naming every allowed severity", () => {
    const prompt = buildReviewPrompt(params);

    expect(prompt).toContain("VERDICT: X");
    for (const verdict of REVIEW_VERDICTS) {
      expect(prompt).toContain(verdict);
    }
  });

  test("tells Claude to read but not to plan on running commands", () => {
    const prompt = buildReviewPrompt(params);

    expect(prompt).toContain("Read the surrounding files");
    expect(prompt).toContain(
      "do not plan to build, typecheck, or execute tests",
    );
  });

  test("tells Codex to read with its shell, sandboxed read-only", () => {
    // Codex reads files *through* its shell, so its note must not say "you
    // cannot run commands" — that would talk it out of reading at all.
    const prompt = buildReviewPrompt({
      ...params,
      accessNote: CODEX_ACCESS_NOTE,
    });

    expect(prompt).toContain("your sandbox is read-only");
    expect(prompt).not.toContain("You cannot run commands");
  });

  test("tolerates missing review instructions", () => {
    const prompt = buildReviewPrompt({ ...params, reviewInstructions: "" });

    expect(prompt).toContain("## Review Guidelines");
    expect(prompt).toContain("Blocker, Major, Minor, Suggestion");
  });
});

describe("readReviewInstructions", () => {
  test("loads policy only from the trusted base commit", () => {
    const reads: string[] = [];
    const policy = readReviewInstructions(
      "/repo",
      "trusted-base-sha",
      (rootDir, ref, filename) => {
        reads.push(`${rootDir}:${ref}:${filename}`);
        if (filename === "REVIEW.md") return undefined;
        return "TRUSTED POLICY";
      },
    );

    expect(policy).toBe("TRUSTED POLICY");
    expect(reads).toEqual([
      "/repo:trusted-base-sha:REVIEW.md",
      "/repo:trusted-base-sha:AGENTS.md",
    ]);
  });

  test("returns empty policy when the base contains neither file", () => {
    expect(readReviewInstructions("/repo", "base", () => undefined)).toBe("");
  });

  test("propagates policy read failures", () => {
    expect(() =>
      readReviewInstructions("/repo", "base", () => {
        throw new Error("git show failed");
      }),
    ).toThrow("git show failed");
  });
});
