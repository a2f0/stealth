import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
const trustScript = "scripts/checks/checkCommitTrust.sh";
const pushGateFiles = [
  trustScript,
  "scripts/git/hooks/pre-push",
  "scripts/git/install-hooks.sh",
];
const fixtures: string[] = [];

afterEach(() => {
  for (const directory of fixtures.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

/**
 * A repository isolated from the user's git configuration that signs with a
 * throwaway SSH key, so signed and unsigned commits need no GPG setup.
 */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "commit-trust-"));
  fixtures.push(root);
  const cwd = path.join(root, "repo");
  const bin = path.join(root, "bin");
  const bunLog = path.join(root, "bun.log");
  mkdirSync(cwd);
  mkdirSync(bin);
  // The hook's repository checks are stubbed: the push gate is under test.
  writeFileSync(
    path.join(bin, "bun"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${bunLog}"\n`,
  );
  chmodSync(path.join(bin, "bun"), 0o755);
  const { PATH = "/usr/bin:/bin" } = process.env;
  const env = {
    GIT_AUTHOR_EMAIL: "signer@example.com",
    GIT_AUTHOR_NAME: "Signer",
    GIT_COMMITTER_EMAIL: "signer@example.com",
    GIT_COMMITTER_NAME: "Signer",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: root,
    PATH: `${bin}:${PATH}`,
    // SSH signing writes a temporary buffer; keep it inside the fixture.
    TMPDIR: root,
  };
  const run = (...command: string[]) => {
    const result = Bun.spawnSync(command, {
      cwd,
      env,
      stdin: "ignore",
      stderr: "pipe",
      stdout: "pipe",
    });
    return {
      code: result.exitCode,
      stderr: result.stderr.toString(),
      stdout: result.stdout.toString().trim(),
    };
  };
  const must = (...command: string[]) => {
    const result = run(...command);
    expect(result.code, `${command.join(" ")}: ${result.stderr}`).toBe(0);
    return result.stdout;
  };

  const key = path.join(root, "signing-key");
  must("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key);
  const publicKey = readFileSync(`${key}.pub`, "utf8").trim();
  const allowedSigners = path.join(root, "allowed-signers");
  writeFileSync(allowedSigners, `signer@example.com ${publicKey}\n`);
  must("git", "init", "--quiet", "--initial-branch=main");
  must("git", "config", "gpg.format", "ssh");
  must("git", "config", "user.signingkey", key);
  must("git", "config", "gpg.ssh.allowedSignersFile", allowedSigners);

  const commit = (message: string, signed: boolean) => {
    must(
      "git",
      "commit",
      "--quiet",
      "--allow-empty",
      signed ? "-S" : "--no-gpg-sign",
      "-m",
      message,
    );
    return must("git", "rev-parse", "HEAD");
  };
  const copyPushGate = () => {
    for (const file of pushGateFiles) {
      const target = path.join(cwd, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(path.join(repositoryRoot, file)));
      chmodSync(target, 0o755);
    }
  };
  const bunCalls = () => {
    try {
      return readFileSync(bunLog, "utf8").trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  return { bunCalls, commit, copyPushGate, cwd, env, must, root, run };
}

describe("checkCommitTrust.sh", () => {
  const check = (repo: ReturnType<typeof fixture>, range: string) =>
    repo.run("sh", path.join(repositoryRoot, trustScript), "--range", range);

  test("accepts signed commits and rejects an unsigned one", () => {
    const repo = fixture();
    repo.commit("chore: start", true);
    repo.must("git", "switch", "--quiet", "-c", "feature");
    repo.commit("feat: signed work", true);
    expect(repo.must("git", "log", "-1", "--format=%G?")).toBe("G");
    expect(check(repo, "main..HEAD").code).toBe(0);

    const unsigned = repo.commit("feat: unsigned work", false);
    const result = check(repo, "main..HEAD");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `commit ${unsigned} has a missing or invalid signature (status: N)`,
    );
  });

  test("rejects a co-author trailer even on a signed commit", () => {
    const repo = fixture();
    repo.commit("chore: start", true);
    repo.must("git", "switch", "--quiet", "-c", "feature");
    repo.commit(
      "feat: paired\n\nCo-authored-by: Pair <pair@example.com>",
      true,
    );
    const result = check(repo, "main..HEAD");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("has a Co-authored-by trailer");
    expect(result.stderr).toContain("Pair <pair@example.com>");
  });

  test("fails closed when the range cannot be listed", () => {
    const repo = fixture();
    repo.commit("chore: start", true);
    const result = check(repo, "missing..HEAD");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("failed to list commits");
  });
});

describe("pre-push hook", () => {
  function pushFixture() {
    const repo = fixture();
    repo.copyPushGate();
    repo.must("git", "add", "--all");
    repo.commit("chore: add push gate", true);
    repo.must("sh", "scripts/git/install-hooks.sh");
    repo.must("git", "init", "--quiet", "--bare", "remote.git");
    repo.must("git", "remote", "add", "origin", "./remote.git");
    repo.must("git", "switch", "--quiet", "-c", "feature");
    const push = (refspec = "HEAD:refs/heads/feature") =>
      repo.run("git", "push", "--quiet", "origin", refspec);
    return { ...repo, push };
  }

  test("pushes signed commits after the repository checks", () => {
    const repo = pushFixture();
    repo.commit("feat: signed work", true);
    const result = repo.push();
    expect(result.code, result.stderr).toBe(0);
    expect(repo.bunCalls()).toEqual(["run check", "run test"]);
  });

  test("refuses an unsigned commit before running any checks", () => {
    const repo = pushFixture();
    repo.commit("feat: signed work", true);
    repo.commit("feat: unsigned work", false);
    const result = repo.push();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("missing or invalid signature");
    expect(repo.bunCalls()).toEqual([]);
    expect(repo.run("git", "ls-remote", "./remote.git").stdout).toBe("");
  });

  test("refuses an unsigned commit pushed onto an existing branch", () => {
    const repo = pushFixture();
    repo.commit("feat: signed work", true);
    expect(repo.push().code).toBe(0);
    repo.commit("feat: unsigned follow-up", false);
    const result = repo.push();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("missing or invalid signature");
  });

  test("refuses unsigned work carried from local main onto a new branch", () => {
    const repo = pushFixture();
    expect(repo.push("main:refs/heads/main").code).toBe(0);
    repo.must("git", "switch", "--quiet", "main");
    const unsigned = repo.commit("feat: unpushed local main work", false);
    repo.must("git", "switch", "--quiet", "-c", "follow-up");
    repo.commit("feat: signed branch work", true);
    const result = repo.push("HEAD:refs/heads/follow-up");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`commit ${unsigned} has a missing`);
  });

  test("lets a branch deletion through", () => {
    const repo = pushFixture();
    repo.commit("feat: signed work", true);
    expect(repo.push().code).toBe(0);
    const result = repo.push(":refs/heads/feature");
    expect(result.code, result.stderr).toBe(0);
  });

  test("refuses to gate a push with a stale copy of itself", () => {
    const repo = pushFixture();
    repo.commit("feat: signed work", true);
    const source = path.join(repo.cwd, "scripts/git/hooks/pre-push");
    writeFileSync(source, `${readFileSync(source, "utf8")}# changed\n`);
    const result = repo.push();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("pre-push hook is stale");
  });
});

describe("the skills' verify_commit_trust gate", () => {
  const skill = readFileSync(
    path.join(repositoryRoot, ".claude/skills/open-pr/SKILL.md"),
    "utf8",
  );
  const gate = /^verify_commit_trust\(\) \{\n[\s\S]*?\n\}$/m.exec(skill)?.[0];
  const realpath = Bun.which("realpath") ?? "/usr/bin/realpath";
  // The agent's shell may be zsh, whose parameter modifiers once broke it.
  const shells = ["sh", ...(Bun.which("zsh") ? ["zsh"] : [])];

  function gateFixture(withTrustedCopy: boolean) {
    const repo = fixture();
    if (withTrustedCopy) repo.copyPushGate();
    repo.must("git", "add", "--all");
    repo.commit("chore: base", true);
    const base = repo.must("git", "rev-parse", "HEAD");
    repo.must("git", "switch", "--quiet", "-c", "feature");
    const verify = (shell: string, trustBase: string, extraEnv = {}) => {
      const result = Bun.spawnSync(
        [
          shell,
          "-c",
          `REALPATH_BIN=${realpath}\n${gate}\nverify_commit_trust "$1"`,
          shell,
          trustBase,
        ],
        {
          cwd: repo.cwd,
          env: { ...repo.env, ...extraEnv },
          stderr: "pipe",
          stdout: "pipe",
        },
      );
      return { code: result.exitCode, stderr: result.stderr.toString() };
    };
    return { ...repo, base, verify };
  }

  test("is defined in the skill", () => {
    expect(gate).toBeDefined();
  });

  for (const shell of shells) {
    test(`checks commits against the trusted base copy under ${shell}`, () => {
      const repo = gateFixture(true);
      repo.commit("feat: signed work", true);
      const signed = repo.verify(shell, repo.base);
      expect(signed.code, signed.stderr).toBe(0);

      repo.commit("feat: unsigned work", false);
      const unsigned = repo.verify(shell, repo.base);
      expect(unsigned.code).not.toBe(0);
      expect(unsigned.stderr).toContain("missing or invalid signature");
      expect(unsigned.stderr).toContain("refusing to push");
    });

    test(`refuses a missing base rather than check nothing under ${shell}`, () => {
      const repo = gateFixture(true);
      repo.commit("feat: unsigned work", false);
      for (const trustBase of ["", "not-a-commit"]) {
        const result = repo.verify(shell, trustBase);
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain("needs the trusted base commit");
      }
    });

    test(`takes the check only from the base under ${shell}`, () => {
      const repo = gateFixture(false);
      repo.commit("feat: signed work", true);
      // A copy outside the repository is never a substitute for the base's.
      const outside = path.join(repo.root, "checkCommitTrust.sh");
      writeFileSync(
        outside,
        readFileSync(path.join(repositoryRoot, trustScript)),
      );
      const result = repo.verify(shell, repo.base, {
        TEARLEADS_COMMIT_TRUST_SCRIPT: outside,
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("base has no commit-trust check");
    });
  }
});
