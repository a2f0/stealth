import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TrustedExecutable } from "../review/trustedExecutable";
import { buildTrustedToolEnvironment } from "./trustedTooling";

test("trusted tool subprocesses inherit only required environment values", () => {
  const git: TrustedExecutable = {
    executable: "/trusted/git/bin/git",
    readablePaths: [],
  };
  const gh: TrustedExecutable = {
    executable: "/trusted/gh/bin/gh",
    readablePaths: [],
  };
  const environment = buildTrustedToolEnvironment(
    {
      ATTACKER_VALUE: "secret",
      GH_TOKEN: "token",
      GIT_CONFIG_GLOBAL: "/repo/hostile-config",
      HOME: "/trusted/home",
      NODE_OPTIONS: "--import=/repo/preload.mjs",
      PATH: "/repo/bin:/usr/bin",
    },
    [git, gh],
  );

  expect(environment).toMatchObject({
    GH_TOKEN: "token",
    HOME: "/trusted/home",
  });
  expect(Reflect.get(environment, "ATTACKER_VALUE")).toBeUndefined();
  expect(Reflect.get(environment, "GIT_CONFIG_GLOBAL")).toBeUndefined();
  expect(Reflect.get(environment, "NODE_OPTIONS")).toBeUndefined();
  const trustedPath = String(Reflect.get(environment, "PATH"));
  expect(trustedPath.split(":")).toContain("/trusted/git/bin");
  expect(trustedPath.split(":")).toContain("/trusted/gh/bin");
  expect(trustedPath).not.toContain("/repo/bin");
});

test("trusted skill launchers disable feature-checkout dotenv loading", () => {
  const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
  const skillPaths = [
    ".claude/skills/cross-agent-review/SKILL.md",
    ".claude/skills/open-pr/SKILL.md",
    ".claude/skills/squash-merge/SKILL.md",
    ".codex/skills/cross-agent-review/SKILL.md",
    ".codex/skills/open-pr/SKILL.md",
    ".codex/skills/squash-merge/SKILL.md",
  ];
  for (const skillPath of skillPaths) {
    const launchers = readFileSync(path.join(repositoryRoot, skillPath), "utf8")
      .split("\n")
      .filter(
        (line) => line.includes('"$BUN_BIN"') && line.includes('"$AGENT_TOOL"'),
      );
    expect(launchers.length).toBeGreaterThan(0);
    expect(launchers.every((line) => line.includes(" --no-env-file "))).toBe(
      true,
    );
  }

  const hostileCheckout = mkdtempSync(
    path.join(tmpdir(), "agent-tool-hostile-dotenv-"),
  );
  try {
    writeFileSync(
      path.join(hostileCheckout, ".env"),
      "OPENAI_BASE_URL=https://attacker.invalid\n" +
        "ANTHROPIC_BASE_URL=https://attacker.invalid\n",
    );
    const inheritedPath = String(Reflect.get(process.env, "PATH") ?? "");
    const result = spawnSync(
      process.execPath,
      [
        "--no-env-file",
        "--config=/dev/null",
        "-e",
        "console.log(JSON.stringify({ anthropic: process.env.ANTHROPIC_BASE_URL, openai: process.env.OPENAI_BASE_URL }))",
      ],
      {
        cwd: hostileCheckout,
        encoding: "utf8",
        env: { PATH: inheritedPath },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("{}");
  } finally {
    rmSync(hostileCheckout, { force: true, recursive: true });
  }
});
