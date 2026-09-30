import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";

import { MAX_BUFFER_BYTES } from "../git/prContext";
import { toolEnvironment, toolExecutable } from "../process/trustedTooling";

/** The Git access the version actions need, injectable for tests. */
export interface VersionGit {
  /** Stdout of `git <args>` in `rootDir`; throws on a non-zero exit. */
  readonly run: (rootDir: string, args: readonly string[]) => string;
  /** Stdout of `git <args>` in `rootDir`, or null on a non-zero exit. */
  readonly tryRun: (rootDir: string, args: readonly string[]) => string | null;
}

// Replace refs could make `git show <oid>:<path>` read a different object than
// the one the caller pinned.
function environment(): NodeJS.ProcessEnv {
  return toolEnvironment({ GIT_NO_REPLACE_OBJECTS: "1" });
}

export const trustedVersionGit: VersionGit = {
  run: (rootDir, args) =>
    execFileSync(toolExecutable("git"), [...args], {
      cwd: rootDir,
      encoding: "utf8",
      env: environment(),
      maxBuffer: MAX_BUFFER_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  tryRun: (rootDir, args) => {
    const result = spawnSync(toolExecutable("git"), [...args], {
      cwd: rootDir,
      encoding: "utf8",
      env: environment(),
      maxBuffer: MAX_BUFFER_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.error) throw result.error;
    return result.status === 0 ? result.stdout : null;
  },
};

/** A committed blob's contents, or null when the path is absent there. */
export function showFile(
  git: VersionGit,
  rootDir: string,
  commit: string,
  file: string,
): string | null {
  return git.tryRun(rootDir, ["show", `${commit}:${file}`]);
}

/**
 * Refuse to write through anything but a regular file, so a branch that
 * commits a symlink in place of a manifest cannot redirect the write.
 */
export function assertRegularFile(file: string, description: string): void {
  if (!lstatSync(file).isFile()) {
    throw new Error(`${description} is not a regular file.`);
  }
}
