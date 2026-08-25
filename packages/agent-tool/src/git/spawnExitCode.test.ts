import { describe, expect, test } from "bun:test";

import { assertSpawnSucceeded, spawnExitCode } from "./prContext";

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
