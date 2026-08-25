import { describe, expect, test } from "bun:test";

import {
  assertCleanReviewWorktree,
  assertFetchedCommit,
  assertPrHeadMatchesLocal,
  assertSameReviewContext,
  assertSpawnSucceeded,
  selectOpenPrNumber,
  spawnExitCode,
} from "./prContext";

describe("assertCleanReviewWorktree", () => {
  test("accepts an empty status and rejects unreviewed files", () => {
    expect(() => assertCleanReviewWorktree("")).not.toThrow();
    expect(() => assertCleanReviewWorktree(" M src/a.ts\n?? src/b.ts")).toThrow(
      "Review worktree is not clean",
    );
  });
});

describe("assertSameReviewContext", () => {
  const context = {
    baseRef: "base-1",
    branch: "feat/widget",
    headRef: "head-1",
    prNumber: "12",
    repo: "a2f0/stealth",
    title: "feat: widget",
  };

  test("rejects a base or PR identity that changes during review", () => {
    expect(() => assertSameReviewContext(context, context)).not.toThrow();
    expect(() =>
      assertSameReviewContext(context, { ...context, baseRef: "base-2" }),
    ).toThrow("pinned base, or pinned head changed");
    expect(() =>
      assertSameReviewContext(context, { ...context, prNumber: "13" }),
    ).toThrow("pinned base, or pinned head changed");
    expect(() =>
      assertSameReviewContext(context, { ...context, headRef: "head-2" }),
    ).toThrow("pinned base, or pinned head changed");
  });
});

describe("assertPrHeadMatchesLocal", () => {
  test("rejects a local checkout that differs from the PR head", () => {
    expect(() => assertPrHeadMatchesLocal("head-1", "head-1")).not.toThrow();
    expect(() => assertPrHeadMatchesLocal("head-1", "head-2")).toThrow(
      "does not match the PR head",
    );
  });
});

describe("selectOpenPrNumber", () => {
  const prs = JSON.stringify([
    {
      headRepository: { nameWithOwner: "fork-one/project" },
      number: 12,
    },
    {
      headRepository: { nameWithOwner: "fork-two/project" },
      number: 34,
    },
  ]);

  test("matches a PR to the branch push repository", () => {
    expect(selectOpenPrNumber(prs, "fork-two/project")).toBe("34");
    expect(selectOpenPrNumber("[]", "fork-two/project")).toBe("");
    expect(selectOpenPrNumber(prs, "another/project")).toBe("");
  });

  test("rejects ambiguous or unresolvable fork PRs", () => {
    expect(() => selectOpenPrNumber(prs, "")).toThrow("same-named fork PR");
    const duplicates = JSON.stringify([
      ...JSON.parse(prs),
      {
        headRepository: { nameWithOwner: "fork-two/project" },
        number: 56,
      },
    ]);
    expect(() => selectOpenPrNumber(duplicates, "fork-two/project")).toThrow(
      "Found 2 open PRs",
    );
  });
});

describe("assertFetchedCommit", () => {
  test("accepts the expected commit and an unspecified expectation", () => {
    expect(() => assertFetchedCommit("main", "abc", "abc")).not.toThrow();
    expect(() => assertFetchedCommit("main", "", "abc")).not.toThrow();
  });

  test("rejects a base that changed after the PR snapshot", () => {
    expect(() => assertFetchedCommit("main", "abc", "def")).toThrow(
      "GitHub reported abc",
    );
  });
});

describe("assertSpawnSucceeded", () => {
  test("accepts a successful command", () => {
    expect(() =>
      assertSpawnSucceeded("git fetch", { status: 0, signal: null }),
    ).not.toThrow();
  });

  test("rejects fetch exits, signals, and launch failures", () => {
    expect(() =>
      assertSpawnSucceeded("git fetch", { status: 1, signal: null }),
    ).toThrow("git fetch exited with code 1");
    expect(() =>
      assertSpawnSucceeded("git fetch", { status: null, signal: "SIGKILL" }),
    ).toThrow("git fetch terminated by signal SIGKILL");
    expect(() =>
      assertSpawnSucceeded("git fetch", {
        error: new Error("ENOENT"),
        signal: null,
        status: null,
      }),
    ).toThrow("Failed to run git fetch: ENOENT");
  });
});

describe("spawnExitCode", () => {
  test("passes through a real exit code", () => {
    expect(spawnExitCode("claude", { status: 0, signal: null })).toBe(0);
    expect(spawnExitCode("claude", { status: 2, signal: null })).toBe(2);
  });

  test("treats a missing binary (no status) as failure", () => {
    const result = {
      status: null,
      signal: null,
      error: new Error("spawn codex ENOENT"),
    };
    expect(spawnExitCode("codex", result)).toBe(1);
  });

  test("treats signal termination as failure", () => {
    expect(spawnExitCode("codex", { status: null, signal: "SIGKILL" })).toBe(1);
  });

  test("treats a null status with no error/signal as failure", () => {
    expect(spawnExitCode("claude", { status: null, signal: null })).toBe(1);
  });
});
