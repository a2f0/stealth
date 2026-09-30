import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
        (line) =>
          line.includes('"$BUN_BIN"') &&
          (line.includes('"$AGENT_TOOL"') || line.includes('"$VERSION_TOOL')),
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
    const mergeGuard = review.indexOf('if [ "$REPORT_ONLY" != true ]; then');
    const merge = review.indexOf(
      'git -c core.hooksPath=/dev/null merge -S --no-edit "$FETCHED_BASE"',
    );
    const push = review.indexOf(
      'git push --no-verify "$FEATURE_REMOTE" "HEAD:$BRANCH"',
    );
    expect(review).toContain("skill arguments are not");
    expect(review).toContain(
      "`REPORT_ONLY=true` exactly when `--report-only` was supplied",
    );
    expect(mergeGuard).toBeGreaterThan(-1);
    expect(merge).toBeGreaterThan(mergeGuard);
    expect(push).toBeGreaterThan(merge);

    const guardEnd = review.indexOf("\n   ```", mergeGuard);
    expect(guardEnd).toBeGreaterThan(mergeGuard);
    const guardScript = review.slice(mergeGuard, guardEnd);
    const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "skill-guard-"));
    try {
      const callsFile = path.join(temporaryDirectory, "calls");
      // Stubs are shell functions rather than freshly written executables,
      // which Linux can refuse to exec (ETXTBSY). The trusted launcher prints
      // one rewritten manifest for a bump, and git drains the pathspecs piped
      // to `add` as real git does, recording them.
      const stubs = [
        "bun_stub() {",
        '  printf \'bun %s\\n\' "$*" >> "$CALLS"',
        '  case "$*" in',
        "    *\" bumpVersions \"*) printf 'packages/client/package.json\\n' ;;",
        '    *" resolveVersionConflicts") return "$RESOLVE_STATUS" ;;',
        "  esac",
        "}",
        "git() {",
        '  printf \'%s\\n\' "$*" >> "$CALLS"',
        "  if [ \"$1\" = rev-parse ]; then printf 'head\\n'; fi",
        '  case "$*" in',
        '    *" add --pathspec-from-file=-") cat >> "$CALLS" ;;',
        '    *" merge -S "*) return "$MERGE_STATUS" ;;',
        "  esac",
        '  if [ "$1" = diff ]; then return "$DIFF_STATUS"; fi',
        "}",
      ].join("\n");
      const shell = `set -euo pipefail\n${stubs}\n${guardScript}`;
      const runGuard = (
        reportOnly: string,
        bumpVersions: string,
        {
          diffStatus = "0",
          mergeStatus = "0",
          resolveStatus = "0",
          versionTool = "agent-tool.ts",
        } = {},
      ) => {
        writeFileSync(callsFile, "");
        const result = spawnSync("/bin/bash", ["-c", shell], {
          encoding: "utf8",
          env: {
            AGENT_TOOL: "agent-tool.ts",
            BASE_REF: "main",
            BRANCH: "feature",
            BUMP_VERSIONS: bumpVersions,
            BUN_BIN: "bun_stub",
            CALLS: callsFile,
            DIFF_STATUS: diffStatus,
            FETCHED_BASE: "base",
            MERGE_STATUS: mergeStatus,
            PR_NUMBER: "",
            REPORT_ONLY: reportOnly,
            RESOLVE_STATUS: resolveStatus,
            VERSION_TOOL: versionTool,
          },
        });
        return {
          calls: readFileSync(callsFile, "utf8"),
          status: result.status,
          stderr: result.stderr,
        };
      };
      const bump =
        "bun --no-env-file --config=/dev/null agent-tool.ts bumpVersions base";
      const bumpCommit =
        "-c core.hooksPath=/dev/null commit -S -m chore: bump package versions";

      for (const bumpVersions of ["true", "false"]) {
        expect(runGuard("true", bumpVersions)).toMatchObject({
          calls: "",
          status: 0,
        });
      }

      const plain = runGuard("false", "false");
      expect(plain.status).toBe(0);
      expect(plain.calls).toContain("merge -S --no-edit base");
      expect(plain.calls).not.toContain("bumpVersions");
      expect(plain.calls).not.toContain(" commit ");

      const bumped = runGuard("false", "true");
      expect(bumped).toMatchObject({ stderr: "", status: 0 });
      const mergeCall = bumped.calls.indexOf("merge -S --no-edit base");
      const bumpCall = bumped.calls.indexOf(bump);
      // Staging writes the index, which would otherwise run post-index-change.
      const addCall = bumped.calls.indexOf(
        "-c core.hooksPath=/dev/null add --pathspec-from-file=-",
      );
      const commitCall = bumped.calls.indexOf(bumpCommit);
      expect(mergeCall).toBeGreaterThan(-1);
      expect(bumpCall).toBeGreaterThan(mergeCall);
      expect(addCall).toBeGreaterThan(bumpCall);
      expect(bumped.calls).toContain(
        "add --pathspec-from-file=-\npackages/client/package.json\n",
      );
      expect(commitCall).toBeGreaterThan(addCall);

      // A conflicted sync is finished only for version-only conflicts under
      // --bump-versions; anything else aborts the merge and stops.
      const resolved = runGuard("false", "true", { mergeStatus: "1" });
      expect(resolved.status).toBe(0);
      expect(resolved.calls).toContain("resolveVersionConflicts");
      expect(resolved.calls).toContain(
        "-c core.hooksPath=/dev/null commit -S --no-edit",
      );
      expect(resolved.calls).not.toContain("merge --abort");
      expect(resolved.calls).toContain(bump);

      for (const [bumpVersions, resolveStatus] of [
        ["false", "0"],
        ["true", "1"],
      ] as const) {
        const aborted = runGuard("false", bumpVersions, {
          mergeStatus: "1",
          resolveStatus,
        });
        expect(aborted.status).toBe(1);
        expect(aborted.calls).toContain(
          "-c core.hooksPath=/dev/null merge --abort",
        );
        expect(aborted.calls).not.toContain(" commit ");
        expect(aborted.calls).not.toContain("bumpVersions");
      }

      // A base whose tool predates the version actions ships only a branch
      // that leaves the versioned packages exactly as the base has them.
      const unchanged =
        "diff --quiet base HEAD -- packages/api packages/client";
      const bootstrap = runGuard("false", "true", { versionTool: "" });
      expect(bootstrap.status).toBe(0);
      expect(bootstrap.calls).toContain(unchanged);
      expect(bootstrap.calls).not.toContain("bun ");
      expect(bootstrap.calls).not.toContain(" commit ");
      const needsBump = runGuard("false", "true", {
        diffStatus: "1",
        versionTool: "",
      });
      expect(needsBump.status).toBe(1);
      expect(needsBump.calls).not.toContain(" commit ");
      const conflicted = runGuard("false", "true", {
        mergeStatus: "1",
        versionTool: "",
      });
      expect(conflicted.status).toBe(1);
      expect(conflicted.calls).toContain("merge --abort");
      expect(conflicted.calls).not.toContain("resolveVersionConflicts");
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }

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

test("cross-agent-review takes version actions only from the fetched base", () => {
  const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
  const snippets = [".claude/skills", ".codex/skills"].map((skillRoot) => {
    const content = readFileSync(
      path.join(repositoryRoot, skillRoot, "cross-agent-review/SKILL.md"),
      "utf8",
    );
    const snippet = /^ *VERSION_TOOL=""\n[\s\S]*?\n *fi$/m.exec(content);
    expect(snippet).not.toBeNull();
    return (snippet?.[0] ?? "")
      .split("\n")
      .map((line) => line.trim())
      .join("\n");
  });
  expect(new Set(snippets).size).toBe(1);

  const [snippet = ""] = snippets;
  const detect = (trustedTmp: string, baseHasVersions: boolean) =>
    spawnSync(
      "/bin/bash",
      [
        "-c",
        `set -eu\ngit() { [ "$*" = "cat-file -e base:packages/agent-tool/src/version/bumpVersions.ts" ] && [ "$HAS_VERSIONS" = 1 ]; }\n${snippet}\nprintf '%s\\n' "$VERSION_TOOL"`,
      ],
      {
        encoding: "utf8",
        env: {
          AGENT_TOOL: "/tool/src/index.ts",
          FETCHED_BASE: "base",
          HAS_VERSIONS: baseHasVersions ? "1" : "0",
          TRUSTED_AGENT_TOOL_TMP: trustedTmp,
        },
      },
    ).stdout.trim();

  expect(detect("/materialized", true)).toBe("/tool/src/index.ts");
  expect(detect("/materialized", false)).toBe("");
  // An agent-tool from TEARLEADS_AGENT_TOOL_DIR (no base snapshot) never
  // supplies the version actions, even when the base has them.
  expect(detect("", true)).toBe("");
});

test("skills survive Claude Code argument substitution", () => {
  const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
  // Invoking a skill with arguments rewrites every bare `$<digit>` and
  // `$ARGUMENTS` in its SKILL.md, shell and awk snippets included, so
  // `tool_name=$1` would run as `tool_name=<second argument>`. Braced shell
  // parameters (`${1}`) and parenthesized awk fields (`$(1)`) are left alone.
  const substituted = /\$ARGUMENTS|\$\d+(?!\w)/g;
  for (const skillRoot of [".claude/skills", ".codex/skills"]) {
    const skills = readdirSync(path.join(repositoryRoot, skillRoot), {
      withFileTypes: true,
    }).filter((entry) => entry.isDirectory());
    expect(skills.length).toBeGreaterThan(0);
    for (const skill of skills) {
      const skillPath = path.join(skillRoot, skill.name, "SKILL.md");
      const content = readFileSync(
        path.join(repositoryRoot, skillPath),
        "utf8",
      );
      expect({ skillPath, matches: content.match(substituted) ?? [] }).toEqual({
        skillPath,
        matches: [],
      });
    }
  }
});

test("ship-pr merges only a branch current with its base", () => {
  const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
  for (const skillRoot of [".claude/skills", ".codex/skills"]) {
    const ship = readFileSync(
      path.join(repositoryRoot, skillRoot, "ship-pr/SKILL.md"),
      "utf8",
    );
    expect(ship).toContain(
      "`cross-agent-review` with\n   **always** `--bump-versions`",
    );

    const gateStart = ship.indexOf("BASE_BRANCH=$(gh pr view");
    const gateEnd = ship.indexOf("\n   ```", gateStart);
    const checks = ship.indexOf('gh pr checks "$PR_NUMBER" --watch');
    const recheck = ship.indexOf("**Run the freshness gate\n   again");
    const merge = ship.indexOf(
      'squash-merge \'\' "$REVIEWED_SHA" "$REVIEWED_BASE_SHA"',
    );
    expect(gateStart).toBeGreaterThan(-1);
    expect(checks).toBeGreaterThan(gateEnd);
    expect(recheck).toBeGreaterThan(checks);
    expect(merge).toBeGreaterThan(recheck);

    const gateScript = ship.slice(gateStart, gateEnd);
    const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "ship-gate-"));
    try {
      const callsFile = path.join(temporaryDirectory, "calls");
      // Shell-function stubs: a freshly written executable can hit ETXTBSY.
      const stubs = [
        'bun_stub() { printf \'bun %s\\n\' "$*" >> "$CALLS"; return "$CHECK_STATUS"; }',
        "git() {",
        '  case "$*" in',
        '    *" fetch --quiet https://github.com/o/r main") ;;',
        '    "rev-parse --verify FETCH_HEAD^{commit}") printf \'%s\\n\' "$FETCHED" ;;',
        '    "rev-parse HEAD") printf \'%s\\n\' "$LOCAL_HEAD" ;;',
        '    "merge-base --is-ancestor $FETCHED reviewed") return "$ANCESTOR_STATUS" ;;',
        '    "diff --quiet $FETCHED reviewed -- packages/api packages/client") return "$DIFF_STATUS" ;;',
        '    "cat-file -e $FETCHED:packages/agent-tool/src/version/bumpVersions.ts") [ "$HAS_VERSIONS" = 1 ] ;;',
        "    \"archive $FETCHED packages/agent-tool\") printf 'archive\\n' ;;",
        "    *) printf 'unexpected git %s\\n' \"$*\" >&2; return 99 ;;",
        "  esac",
        "}",
        'tar() { cat >/dev/null; printf \'tar %s\\n\' "$*" >> "$CALLS"; }',
        "gh() {",
        '  case "$*" in',
        "    *baseRefName*) printf 'main\\n' ;;",
        "    *headRefOid*) printf '%s\\n' \"$PR_HEAD\" ;;",
        "    *baseRefOid*) printf '%s\\n' \"$PR_BASE\" ;;",
        "    *) printf 'unexpected gh %s\\n' \"$*\" >&2; return 99 ;;",
        "  esac",
        "}",
      ].join("\n");
      const shell = `set -euo pipefail\n${stubs}\n${gateScript}\nprintf 'BRANCH_CURRENT=%s\\n' "$BRANCH_CURRENT"`;
      const current = {
        ANCESTOR_STATUS: "0",
        CHECK_STATUS: "0",
        DIFF_STATUS: "0",
        FETCHED: "base",
        HAS_VERSIONS: "1",
        LOCAL_HEAD: "reviewed",
        PR_BASE: "base",
        PR_HEAD: "reviewed",
      };
      const runGate = (overrides: Partial<typeof current> = {}) => {
        writeFileSync(callsFile, "");
        const result = spawnSync("/bin/bash", ["-c", shell], {
          encoding: "utf8",
          env: {
            ...current,
            ...overrides,
            BASE_URL: "https://github.com/o/r",
            BUN_BIN: "bun_stub",
            CALLS: callsFile,
            PR_NUMBER: "7",
            REPO: "o/r",
            REVIEWED_BASE_SHA: "base",
            REVIEWED_SHA: "reviewed",
            TMPDIR: temporaryDirectory,
          },
        });
        return {
          calls: readFileSync(callsFile, "utf8"),
          status: result.status,
          stdout: result.stdout.trim(),
        };
      };

      const passing = runGate();
      expect(passing).toMatchObject({
        status: 0,
        stdout: "BRANCH_CURRENT=true",
      });
      // checkVersions comes from a copy of this exact base, materialized for
      // this run and removed afterwards — never setup's older snapshot.
      expect(passing.calls).toMatch(
        new RegExp(
          `^tar -x -C (${temporaryDirectory}/tearleads-version-tool\\.\\w+)\nbun --no-env-file --config=/dev/null \\1/packages/agent-tool/src/index\\.ts checkVersions base\n$`,
        ),
      );
      expect(
        readdirSync(temporaryDirectory).filter((entry) =>
          entry.startsWith("tearleads-version-tool."),
        ),
      ).toEqual([]);

      // Base advanced past the review, GitHub's snapshot lags the fetched tip,
      // the head lacks the base, or a version trails it: refresh, don't merge.
      for (const stale of [
        { FETCHED: "newer" },
        { PR_BASE: "older" },
        { ANCESTOR_STATUS: "1" },
        { CHECK_STATUS: "1" },
      ]) {
        expect(runGate(stale)).toMatchObject({
          status: 0,
          stdout: "BRANCH_CURRENT=false",
        });
      }
      expect(runGate({ FETCHED: "newer" }).calls).toBe("");

      // A base that predates the version actions accepts only a head whose
      // versioned packages are exactly the base's.
      expect(runGate({ HAS_VERSIONS: "0" })).toMatchObject({
        calls: "",
        status: 0,
        stdout: "BRANCH_CURRENT=true",
      });
      expect(runGate({ DIFF_STATUS: "1", HAS_VERSIONS: "0" })).toMatchObject({
        status: 0,
        stdout: "BRANCH_CURRENT=false",
      });

      // A head that moved off the reviewed commit is never refreshed over.
      for (const moved of [{ LOCAL_HEAD: "other" }, { PR_HEAD: "other" }]) {
        const result = runGate(moved);
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
      }
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
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
