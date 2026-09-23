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
    GCM_INTERACTIVE: "never",
    GH_TOKEN: "token",
    GIT_ASKPASS: "/usr/bin/false",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: "/trusted/home",
  });
  expect(Reflect.get(environment, "ATTACKER_VALUE")).toBeUndefined();
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
    ".claude/skills/ship-pr/SKILL.md",
    ".claude/skills/squash-merge/SKILL.md",
    ".codex/skills/cross-agent-review/SKILL.md",
    ".codex/skills/open-pr/SKILL.md",
    ".codex/skills/ship-pr/SKILL.md",
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
    ".claude/skills/ship-pr/SKILL.md",
    ".claude/skills/squash-merge/SKILL.md",
    ".codex/skills/cross-agent-review/SKILL.md",
    ".codex/skills/open-pr/SKILL.md",
    ".codex/skills/reset/SKILL.md",
    ".codex/skills/ship-pr/SKILL.md",
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

test("cross-agent skills preserve validated reviewer executables", () => {
  const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
  for (const skillPath of [
    ".claude/skills/cross-agent-review/SKILL.md",
    ".codex/skills/cross-agent-review/SKILL.md",
  ]) {
    const content = readFileSync(path.join(repositoryRoot, skillPath), "utf8");
    expect(content).toContain(
      "CLAUDE_BIN=$(resolve_bootstrap_tool claude 2>/dev/null || true)",
    );
    expect(content).toContain(
      "CODEX_BIN=$(resolve_bootstrap_tool codex 2>/dev/null || true)",
    );
    expect(content).toContain("$" + "{REVIEWER_PATH:+:$REVIEWER_PATH}");
  }
});

test("shipping skills fail closed without mutating report-only reviews", () => {
  const repositoryRoot = path.resolve(import.meta.dir, "../../../..");

  for (const skillRoot of [".claude/skills", ".codex/skills"]) {
    const review = readFileSync(
      path.join(repositoryRoot, skillRoot, "cross-agent-review/SKILL.md"),
      "utf8",
    );
    const mergeGuard = review.indexOf('if [ "$REPAIR_ROUNDS" -ne 0 ]; then');
    const merge = review.indexOf(
      'git -c core.hooksPath=/dev/null merge -S --no-edit "$FETCHED_BASE"',
    );
    const push = review.indexOf(
      'git push --no-verify "$FEATURE_REMOTE" "HEAD:$BRANCH"',
    );
    expect(mergeGuard).toBeGreaterThan(-1);
    expect(merge).toBeGreaterThan(mergeGuard);
    expect(push).toBeGreaterThan(merge);

    const openPr = readFileSync(
      path.join(repositoryRoot, skillRoot, "open-pr/SKILL.md"),
      "utf8",
    );
    expect(openPr).toContain(
      'git ls-remote --exit-code --heads "$FEATURE_REMOTE" "$NEW_BRANCH" >/dev/null || REMOTE_BRANCH_STATUS=$?',
    );
    expect(openPr).toContain("2) ;;");
    expect(openPr).toContain(
      '*) echo "Error: could not inspect $FEATURE_REMOTE for $NEW_BRANCH" >&2; exit 1 ;;',
    );
    expect(openPr).toContain(
      'git -c core.hooksPath=/dev/null stash push --include-untracked -m "open-pr: move work to $NEW_BRANCH" || {',
    );
    expect(openPr).toContain(
      "PREVIOUS_STASH_OID=$(git rev-parse --verify --quiet refs/stash || true)",
    );
    expect(openPr).toContain("restore_saved_work() {");
    expect(openPr).toContain(
      'git -c core.hooksPath=/dev/null stash apply --index "$STASH_OID" || {',
    );
    expect(openPr).toContain("restore_saved_work || exit 1");

    const reset = readFileSync(
      path.join(repositoryRoot, skillRoot, "reset/SKILL.md"),
      "utf8",
    );
    expect(reset.indexOf('if [ -z "$TARGET_BRANCH" ]; then')).toBeLessThan(
      reset.indexOf("GH_BIN=$(resolve_bootstrap_tool gh)"),
    );
  }
});

test("shipping skills isolate preflights and disable contributor hooks", () => {
  const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
  const mirroredSkillPaths = [
    ".claude/skills/cross-agent-review/SKILL.md",
    ".claude/skills/open-pr/SKILL.md",
    ".claude/skills/ship-pr/SKILL.md",
    ".claude/skills/squash-merge/SKILL.md",
    ".claude/skills/reset/SKILL.md",
    ".codex/skills/cross-agent-review/SKILL.md",
    ".codex/skills/open-pr/SKILL.md",
    ".codex/skills/ship-pr/SKILL.md",
    ".codex/skills/squash-merge/SKILL.md",
    ".codex/skills/reset/SKILL.md",
  ];
  const preflightSkillPaths = mirroredSkillPaths.filter((skillPath) =>
    /\/(cross-agent-review|open-pr|ship-pr)\//.test(skillPath),
  );

  for (const skillPath of preflightSkillPaths) {
    const content = readFileSync(path.join(repositoryRoot, skillPath), "utf8");
    expect(content).toContain('"$AGENT_TOOL" runPreflight check');
    expect(content).not.toContain("git merge --no-edit");

    const commitCommands = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("git ") && line.includes(" commit "));
    expect(commitCommands.length).toBeGreaterThan(0);
    expect(
      commitCommands.every(
        (line) =>
          line.includes("-c core.hooksPath=/dev/null") &&
          line.includes(" commit -S "),
      ),
    ).toBe(true);
    expect(content).not.toContain("--no-gpg-sign");
    expect(content).not.toContain("gpgSign=false");
  }

  for (const skillPath of mirroredSkillPaths) {
    const content = readFileSync(path.join(repositoryRoot, skillPath), "utf8");
    const mutatingCommands = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("git ") || line.includes("|| git "))
      .filter((line) => {
        const command = line.slice(line.indexOf("git "));
        const withoutConfig = command.replace(
          /^git(?:\s+-c\s+(?:'[^']*'|"[^"]*"|\S+))*/,
          "git",
        );
        return (
          /^git (?:merge|switch|pull)(?:\s|$)/.test(withoutConfig) ||
          /^git stash (?:push|apply|drop)(?:\s|$)/.test(withoutConfig)
        );
      });
    expect(
      mutatingCommands.every((line) =>
        line.includes("-c core.hooksPath=/dev/null"),
      ),
    ).toBe(true);
  }

  for (const skillPath of [
    ".claude/skills/squash-merge/SKILL.md",
    ".codex/skills/squash-merge/SKILL.md",
  ]) {
    const content = readFileSync(path.join(repositoryRoot, skillPath), "utf8");
    expect(content).toContain(
      'git rev-parse --verify "refs/heads/$MERGED_BRANCH^{commit}"',
    );
    expect(content).not.toContain('git rev-parse "$MERGED_BRANCH"');
  }
});

test("shipping skills gate every commit push on the trusted commit-trust check", () => {
  const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
  for (const skillRoot of [".claude/skills", ".codex/skills"]) {
    for (const skill of ["cross-agent-review", "open-pr", "ship-pr"]) {
      const content = readFileSync(
        path.join(repositoryRoot, skillRoot, skill, "SKILL.md"),
        "utf8",
      );
      // Signing and verifying both need the signing program on PATH.
      expect(content).toContain(
        "GPG_BIN=$(resolve_bootstrap_tool gpg 2>/dev/null || true)",
      );
      expect(content).toContain("$" + "{GPG_BIN:+:$" + "{GPG_BIN%/*}}");
      // The check comes from the trusted base, never the feature checkout.
      expect(content).toContain("verify_commit_trust() {");
      expect(content).toContain(
        'git show "$' + '{trust_base}:scripts/checks/checkCommitTrust.sh"',
      );
      expect(content).toContain(
        'sh "$trust_script" --range "$trust_base..HEAD"',
      );

      const lines = content.split("\n").map((line) => line.trim());
      let pushes = 0;
      lines.forEach((line, index) => {
        if (!/^git .* ?push .*--no-verify/.test(line)) return;
        pushes += 1;
        const previous = lines
          .slice(0, index)
          .reverse()
          .find((candidate) => candidate !== "");
        expect(previous).toMatch(/^verify_commit_trust "\$\w+" \|\| exit 1$/);
      });
      expect(pushes).toBeGreaterThanOrEqual(
        skill === "cross-agent-review" ? 2 : 1,
      );
    }

    // A branch delete pushes no commits; it must not run the full hook.
    const squashMerge = readFileSync(
      path.join(repositoryRoot, skillRoot, "squash-merge/SKILL.md"),
      "utf8",
    );
    const deletes = squashMerge
      .split("\n")
      .filter((line) => line.includes(':refs/heads/$MERGED_BRANCH"'));
    expect(deletes.length).toBe(1);
    expect(deletes[0]).toContain("-c core.hooksPath=/dev/null");
    expect(deletes[0]).toContain("push --no-verify");
  }
});

test("shipping skills share one commit-trust gate and avoid zsh modifiers", () => {
  const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
  const gates = new Set<string>();
  for (const skillRoot of [".claude/skills", ".codex/skills"]) {
    for (const skill of [
      "cross-agent-review",
      "open-pr",
      "reset",
      "ship-pr",
      "squash-merge",
    ]) {
      const content = readFileSync(
        path.join(repositoryRoot, skillRoot, skill, "SKILL.md"),
        "utf8",
      );
      // The agent's shell may be zsh, which reads "$VAR:s…" or "$VAR:A…" as
      // history modifiers; every such expansion must be braced.
      expect(content.match(/\$[A-Za-z_]\w*:[A-Za-z&]/g) ?? []).toEqual([]);
      const gate = /^verify_commit_trust\(\) \{\n[\s\S]*?\n\}$/m.exec(content);
      if (gate) gates.add(gate[0]);
    }
  }
  expect(gates.size).toBe(1);
});

test("reset reaches the exact fetched upstream before installing hooks", () => {
  const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
  for (const skillPath of [
    ".claude/skills/reset/SKILL.md",
    ".codex/skills/reset/SKILL.md",
  ]) {
    const content = readFileSync(path.join(repositoryRoot, skillPath), "utf8");
    expect(content).not.toContain(
      "git -c core.hooksPath=/dev/null pull --ff-only",
    );
    const fetch = content.indexOf(
      'git -c core.hooksPath=/dev/null fetch "$REMOTE" "$UPSTREAM_REF"',
    );
    const ancestry = content.indexOf(
      'git merge-base --is-ancestor "$LOCAL_TARGET" "$FETCHED_UPSTREAM"',
    );
    const resolveLocalTarget = content.indexOf(
      'git show-ref --verify --quiet "refs/heads/$TARGET_BRANCH"',
    );
    const createRemoteOnlyTarget = content.indexOf(
      'git -c core.hooksPath=/dev/null switch -c "$TARGET_BRANCH" "$FETCHED_UPSTREAM"',
    );
    const switchExistingTarget = content.indexOf(
      'git -c core.hooksPath=/dev/null switch "$TARGET_BRANCH"',
    );
    const fastForward = content.indexOf(
      'git -c core.hooksPath=/dev/null merge --ff-only "$FETCHED_UPSTREAM"',
    );
    const equality = content.indexOf(
      '[ "$(git rev-parse --verify \'HEAD^{commit}\')" = "$FETCHED_UPSTREAM" ]',
    );
    const install = content.indexOf('sh "$HOOKS_SCRIPT"');
    const confirmInstalled = content.indexOf(
      'cmp -s "$hook" "$HOOKS_DIR/$' + '{hook##*/}"',
    );

    expect(fetch).toBeGreaterThan(-1);
    expect(resolveLocalTarget).toBeGreaterThan(fetch);
    expect(ancestry).toBeGreaterThan(fetch);
    expect(createRemoteOnlyTarget).toBeGreaterThan(ancestry);
    expect(switchExistingTarget).toBeGreaterThan(ancestry);
    expect(fastForward).toBeGreaterThan(ancestry);
    expect(equality).toBeGreaterThan(fastForward);
    expect(install).toBeGreaterThan(equality);
    expect(confirmInstalled).toBeGreaterThan(install);
  }
});

test("in-session review fallback loads policy from the fetched base", () => {
  const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
  for (const skillPath of [
    ".claude/skills/cross-agent-review/SKILL.md",
    ".codex/skills/cross-agent-review/SKILL.md",
  ]) {
    const content = readFileSync(path.join(repositoryRoot, skillPath), "utf8");
    const reviewPolicy = content.indexOf(
      'git show "$' + '{FETCHED_BASE}:REVIEW.md" > "$REVIEW_POLICY_FILE"',
    );
    const agentsPolicy = content.indexOf(
      'git show "$' + '{FETCHED_BASE}:AGENTS.md" > "$REVIEW_POLICY_FILE"',
    );
    const fileReview = content.indexOf(
      "Review each file against the trusted guidelines materialized in",
    );

    expect(reviewPolicy).toBeGreaterThan(-1);
    expect(agentsPolicy).toBeGreaterThan(reviewPolicy);
    expect(fileReview).toBeGreaterThan(agentsPolicy);
    expect(content).toContain(
      "never substitute a working-tree `REVIEW.md` or `AGENTS.md`",
    );
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
