import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { bumpVersions, checkVersions, planVersions } from "./bumpVersions";
import { resolveVersionConflicts } from "./resolveVersionConflicts";
import { createVersionGit } from "./versionGit";

const repositories: string[] = [];
let stdout: string[] = [];

// Isolated from the user's configuration, with an explicit identity: CI
// runners have none, and git merge refuses to start without one.
const { PATH = "/usr/bin:/bin" } = process.env;
const GIT_ENV = {
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_AUTHOR_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  PATH,
};
const GIT_CONFIG = ["-c", "core.hooksPath=/dev/null"];

// The production factory over the PATH git, so every test runs hook-free argv.
const testGit = createVersionGit(
  () => "git",
  () => GIT_ENV,
);

function git(rootDir: string, args: string[]): string {
  return testGit.run(rootDir, args).trim();
}

/** Merge `main` into the checkout, returning git's exit status. */
function mergeMain(rootDir: string): number | null {
  return spawnSync("git", [...GIT_CONFIG, "merge", "--no-edit", "main"], {
    cwd: rootDir,
    env: GIT_ENV,
    stdio: "ignore",
  }).status;
}

function manifest(name: string, version: string, extra = ""): string {
  return `{
  "name": "${name}",
  "version": "${version}",
  "private": true,${extra}
  "type": "module"
}
`;
}

function write(rootDir: string, file: string, source: string): void {
  const target = path.join(rootDir, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, source);
}

function read(rootDir: string, file: string): string {
  return readFileSync(path.join(rootDir, file), "utf8");
}

function commitAll(rootDir: string, message: string): string {
  git(rootDir, ["add", "-A"]);
  git(rootDir, ["commit", "-q", "-m", message]);
  return git(rootDir, ["rev-parse", "HEAD"]);
}

const CLIENT = "packages/client/package.json";
const API = "packages/api/package.json";

/** A repo on `main` with both versioned packages, checked out on `feature`. */
function repository(): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), "agent-tool-versions-"));
  repositories.push(rootDir);
  git(rootDir, ["init", "-q", "-b", "main"]);
  write(rootDir, CLIENT, manifest("@tearleads/client", "0.1.0"));
  write(rootDir, "packages/client/src/app.ts", "export {};\n");
  write(rootDir, API, manifest("@tearleads/api", "0.2.0"));
  write(rootDir, "packages/api/src/app.ts", "export {};\n");
  write(rootDir, "README.md", "demo\n");
  commitAll(rootDir, "chore: initial");
  git(rootDir, ["checkout", "-q", "-b", "feature"]);
  return rootDir;
}

/** Commit on `main` without leaving `feature`, returning the new main OID. */
function commitOnMain(rootDir: string, files: Record<string, string>): string {
  git(rootDir, ["checkout", "-q", "main"]);
  for (const [file, source] of Object.entries(files)) {
    write(rootDir, file, source);
  }
  const oid = commitAll(rootDir, "chore: main moves");
  git(rootDir, ["checkout", "-q", "feature"]);
  return oid;
}

function mainOid(rootDir: string): string {
  return git(rootDir, ["rev-parse", "main"]);
}

beforeEach(() => {
  stdout = [];
  spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  mock.restore();
  for (const rootDir of repositories.splice(0)) {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

describe("bumpVersions", () => {
  test("patch-bumps only the packages the branch changes", () => {
    const rootDir = repository();
    write(rootDir, "packages/client/src/app.ts", "export const a = 1;\n");
    commitAll(rootDir, "feat: change client");
    const base = mainOid(rootDir);

    expect(checkVersions(rootDir, base, testGit)).toBe(1);
    expect(bumpVersions(rootDir, base, testGit)).toBe(0);

    expect(stdout.join("")).toBe(`${CLIENT}\n`);
    expect(read(rootDir, CLIENT)).toBe(manifest("@tearleads/client", "0.1.1"));
    expect(read(rootDir, API)).toBe(manifest("@tearleads/api", "0.2.0"));
    commitAll(rootDir, "chore: bump package versions");
    expect(checkVersions(rootDir, base, testGit)).toBe(0);
  });

  test("bumps both packages when the branch changes both", () => {
    const rootDir = repository();
    write(rootDir, "packages/client/src/app.ts", "export const a = 1;\n");
    write(rootDir, "packages/api/src/app.ts", "export const b = 1;\n");
    commitAll(rootDir, "feat: change both");

    bumpVersions(rootDir, mainOid(rootDir), testGit);
    expect(stdout.join("")).toBe(`${API}\n${CLIENT}\n`);
    expect(read(rootDir, API)).toBe(manifest("@tearleads/api", "0.2.1"));
  });

  test("is a no-op once the branch carries the bump", () => {
    const rootDir = repository();
    write(rootDir, "packages/api/src/app.ts", "export const b = 1;\n");
    write(rootDir, API, manifest("@tearleads/api", "0.2.1"));
    commitAll(rootDir, "feat: change api");

    expect(bumpVersions(rootDir, mainOid(rootDir), testGit)).toBe(0);
    expect(stdout).toEqual([]);
  });

  test("ignores changes outside the versioned packages", () => {
    const rootDir = repository();
    write(rootDir, "README.md", "changed\n");
    write(rootDir, "packages/ui/src/index.ts", "export {};\n");
    commitAll(rootDir, "docs: readme");

    expect(checkVersions(rootDir, mainOid(rootDir), testGit)).toBe(0);
  });

  test("re-bumps past a base that took the same version first", () => {
    const rootDir = repository();
    write(rootDir, "packages/client/src/app.ts", "export const a = 1;\n");
    write(rootDir, CLIENT, manifest("@tearleads/client", "0.1.1"));
    commitAll(rootDir, "feat: change client");
    const base = commitOnMain(rootDir, {
      "packages/client/src/other.ts": "export {};\n",
      [CLIENT]: manifest("@tearleads/client", "0.1.1"),
    });
    git(rootDir, ["merge", "-q", "--no-edit", base]);

    expect(planVersions(rootDir, base, testGit)).toContainEqual({
      manifest: CLIENT,
      baseVersion: "0.1.1",
      headVersion: "0.1.1",
      targetVersion: "0.1.2",
    });
    bumpVersions(rootDir, base, testGit);
    expect(read(rootDir, CLIENT)).toBe(manifest("@tearleads/client", "0.1.2"));
  });

  test("returns a version-only change to the base version", () => {
    const rootDir = repository();
    write(rootDir, CLIENT, manifest("@tearleads/client", "0.1.1"));
    commitAll(rootDir, "chore: stale bump");

    bumpVersions(rootDir, mainOid(rootDir), testGit);
    expect(read(rootDir, CLIENT)).toBe(manifest("@tearleads/client", "0.1.0"));
  });

  test("counts manifest edits beyond the version as a change", () => {
    const rootDir = repository();
    write(
      rootDir,
      CLIENT,
      manifest("@tearleads/client", "0.1.0", '\n  "license": "MIT",'),
    );
    commitAll(rootDir, "chore: add license");

    bumpVersions(rootDir, mainOid(rootDir), testGit);
    expect(read(rootDir, CLIENT)).toBe(
      manifest("@tearleads/client", "0.1.1", '\n  "license": "MIT",'),
    );
  });

  test("keeps a deliberate minor release", () => {
    const rootDir = repository();
    write(rootDir, "packages/client/src/app.ts", "export const a = 1;\n");
    write(rootDir, CLIENT, manifest("@tearleads/client", "0.2.0"));
    commitAll(rootDir, "feat: release client 0.2");

    expect(checkVersions(rootDir, mainOid(rootDir), testGit)).toBe(0);
  });

  test("refuses to overwrite uncommitted manifest edits", () => {
    const rootDir = repository();
    write(rootDir, "packages/client/src/app.ts", "export const a = 1;\n");
    commitAll(rootDir, "feat: change client");
    write(
      rootDir,
      CLIENT,
      manifest("@tearleads/client", "0.1.0", '\n  "x": 1,'),
    );

    expect(() => bumpVersions(rootDir, mainOid(rootDir), testGit)).toThrow(
      "uncommitted changes",
    );
  });

  test("refuses to drop staged manifest edits", () => {
    const rootDir = repository();
    write(rootDir, "packages/client/src/app.ts", "export const a = 1;\n");
    commitAll(rootDir, "feat: change client");
    write(
      rootDir,
      CLIENT,
      manifest("@tearleads/client", "0.1.0", '\n  "x": 1,'),
    );
    git(rootDir, ["add", CLIENT]);
    write(rootDir, CLIENT, manifest("@tearleads/client", "0.1.0"));

    expect(() => bumpVersions(rootDir, mainOid(rootDir), testGit)).toThrow(
      "uncommitted changes",
    );
  });

  test("refuses to write through a symlinked manifest", () => {
    const rootDir = repository();
    write(rootDir, "packages/client/src/app.ts", "export const a = 1;\n");
    commitAll(rootDir, "feat: change client");
    const outside = path.join(rootDir, "..", `${path.basename(rootDir)}.txt`);
    writeFileSync(outside, read(rootDir, CLIENT));
    repositories.push(outside);
    unlinkSync(path.join(rootDir, CLIENT));
    symlinkSync(outside, path.join(rootDir, CLIENT));

    expect(() => bumpVersions(rootDir, mainOid(rootDir), testGit)).toThrow(
      "not a regular file",
    );
    expect(readFileSync(outside, "utf8")).toBe(
      manifest("@tearleads/client", "0.1.0"),
    );
  });

  test("requires a full base OID", () => {
    const rootDir = repository();
    expect(() => bumpVersions(rootDir, "main", testGit)).toThrow(
      "full Git OID",
    );
  });
});

describe("resolveVersionConflicts", () => {
  test("takes the base version and keeps both sides' other edits", () => {
    const rootDir = repository();
    write(rootDir, "packages/client/src/app.ts", "export const a = 1;\n");
    write(rootDir, CLIENT, manifest("@tearleads/client", "0.1.1"));
    commitAll(rootDir, "feat: change client");
    commitOnMain(rootDir, {
      [CLIENT]: manifest("@tearleads/client", "0.1.2", '\n  "license": "MIT",'),
    });
    expect(mergeMain(rootDir)).not.toBe(0);

    expect(resolveVersionConflicts(rootDir, testGit)).toBe(0);
    expect(read(rootDir, CLIENT)).toBe(
      manifest("@tearleads/client", "0.1.2", '\n  "license": "MIT",'),
    );
    expect(git(rootDir, ["diff", "--name-only", "--diff-filter=U"])).toBe("");
    git(rootDir, ["commit", "-q", "--no-edit"]);

    bumpVersions(rootDir, mainOid(rootDir), testGit);
    expect(read(rootDir, CLIENT)).toBe(
      manifest("@tearleads/client", "0.1.3", '\n  "license": "MIT",'),
    );
  });

  test("keeps the branch's deliberate minor release", () => {
    const rootDir = repository();
    write(rootDir, "packages/client/src/app.ts", "export const a = 1;\n");
    write(rootDir, CLIENT, manifest("@tearleads/client", "0.2.0"));
    commitAll(rootDir, "feat: release client 0.2");
    commitOnMain(rootDir, {
      [CLIENT]: manifest("@tearleads/client", "0.1.2", '\n  "license": "MIT",'),
    });
    expect(mergeMain(rootDir)).not.toBe(0);

    expect(resolveVersionConflicts(rootDir, testGit)).toBe(0);
    expect(read(rootDir, CLIENT)).toBe(
      manifest("@tearleads/client", "0.2.0", '\n  "license": "MIT",'),
    );
    git(rootDir, ["commit", "-q", "--no-edit"]);
    expect(checkVersions(rootDir, mainOid(rootDir), testGit)).toBe(0);
  });

  test("touches nothing when another file conflicts", () => {
    const rootDir = repository();
    write(rootDir, "README.md", "branch\n");
    write(rootDir, CLIENT, manifest("@tearleads/client", "0.1.1"));
    commitAll(rootDir, "feat: change readme");
    commitOnMain(rootDir, {
      "README.md": "main\n",
      [CLIENT]: manifest("@tearleads/client", "0.1.2"),
    });
    expect(mergeMain(rootDir)).not.toBe(0);
    const before = read(rootDir, CLIENT);

    expect(resolveVersionConflicts(rootDir, testGit)).toBe(1);
    expect(read(rootDir, CLIENT)).toBe(before);
    expect(git(rootDir, ["diff", "--name-only", "--diff-filter=U"])).toContain(
      CLIENT,
    );
  });

  test("refuses a manifest that conflicts beyond its version", () => {
    const rootDir = repository();
    write(
      rootDir,
      CLIENT,
      manifest("@tearleads/client", "0.1.1", '\n  "license": "ISC",'),
    );
    commitAll(rootDir, "chore: license");
    commitOnMain(rootDir, {
      [CLIENT]: manifest("@tearleads/client", "0.1.2", '\n  "license": "MIT",'),
    });
    expect(mergeMain(rootDir)).not.toBe(0);

    expect(resolveVersionConflicts(rootDir, testGit)).toBe(1);
  });

  test("requires a merge in progress", () => {
    expect(resolveVersionConflicts(repository(), testGit)).toBe(1);
  });

  test("runs no repository hook while staging or bumping", () => {
    const rootDir = repository();
    const marker = `${rootDir}.hook-ran`;
    repositories.push(marker);
    const hook = path.join(rootDir, ".git/hooks/post-index-change");
    mkdirSync(path.dirname(hook), { recursive: true });
    writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(hook, 0o755);
    // Control: an ordinary index write does run the hook.
    write(rootDir, "README.md", "control\n");
    spawnSync("git", ["add", "README.md"], { cwd: rootDir, env: GIT_ENV });
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    write(rootDir, "packages/client/src/app.ts", "export const a = 1;\n");
    write(rootDir, CLIENT, manifest("@tearleads/client", "0.1.1"));
    commitAll(rootDir, "feat: change client");
    commitOnMain(rootDir, {
      [CLIENT]: manifest("@tearleads/client", "0.1.2", '\n  "license": "MIT",'),
    });
    expect(mergeMain(rootDir)).not.toBe(0);
    expect(resolveVersionConflicts(rootDir, testGit)).toBe(0);
    git(rootDir, ["commit", "-q", "--no-edit"]);
    bumpVersions(rootDir, mainOid(rootDir), testGit);

    expect(read(rootDir, CLIENT)).toContain('"version": "0.1.3"');
    expect(existsSync(marker)).toBe(false);
  });
});
