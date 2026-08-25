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
  const credentialedSkillPaths = [
    ".claude/skills/cross-agent-review/SKILL.md",
    ".claude/skills/open-pr/SKILL.md",
    ".claude/skills/squash-merge/SKILL.md",
    ".codex/skills/cross-agent-review/SKILL.md",
    ".codex/skills/open-pr/SKILL.md",
    ".codex/skills/squash-merge/SKILL.md",
  ];
  for (const skillPath of credentialedSkillPaths) {
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

test("shipping skills bootstrap tools outside the feature checkout", () => {
  const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
  const skillPaths = [
    ".claude/skills/cross-agent-review/SKILL.md",
    ".claude/skills/open-pr/SKILL.md",
    ".claude/skills/reset/SKILL.md",
    ".claude/skills/squash-merge/SKILL.md",
    ".codex/skills/cross-agent-review/SKILL.md",
    ".codex/skills/open-pr/SKILL.md",
    ".codex/skills/reset/SKILL.md",
    ".codex/skills/squash-merge/SKILL.md",
  ];

  for (const skillPath of skillPaths) {
    const content = readFileSync(path.join(repositoryRoot, skillPath), "utf8");
    const bootstrapStart = content.indexOf("REALPATH_BIN=/usr/bin/realpath");
    expect(bootstrapStart).toBeGreaterThan(-1);
    const bootstrap = content.slice(bootstrapStart);
    expect(bootstrap).toContain("resolve_bootstrap_tool() {");
    expect(bootstrap).toContain("GIT_BIN=$(resolve_bootstrap_tool git)");
    expect(bootstrap).toContain("GH_BIN=$(resolve_bootstrap_tool gh)");
    expect(bootstrap).toContain("export PATH");

    const pathExport = bootstrap.indexOf("export PATH");
    expect(pathExport).toBeGreaterThan(-1);
    expect(pathExport).toBeLessThan(bootstrap.indexOf("git rev-parse"));
    expect(pathExport).toBeLessThan(bootstrap.indexOf("gh repo view"));
  }
});

test("open-pr validates branch names without feature-checkout code", () => {
  const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
  for (const skillPath of [
    ".claude/skills/open-pr/SKILL.md",
    ".codex/skills/open-pr/SKILL.md",
  ]) {
    const content = readFileSync(path.join(repositoryRoot, skillPath), "utf8");
    expect(content).not.toContain("bun run lint:branch-name");
    expect(content).toContain("branch names must match <type>/<name>");
    expect(content).toContain(
      "build chore ci cleanup docs feat fix perf refactor revert style test",
    );
  }
});
