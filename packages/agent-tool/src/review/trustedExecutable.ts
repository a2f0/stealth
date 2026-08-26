import { execFileSync } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import path from "node:path";

import type { ReviewerEnv } from "./runReview";

const SYSTEM_EXECUTABLE_PATHS = [
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
];

export interface TrustedExecutable {
  readonly executable: string;
  readonly readablePaths: string[];
}

function versionedRuntimeRoot(resolvedExecutable: string): string | undefined {
  const parts = path.resolve(resolvedExecutable).split(path.sep);
  const cellarIndex = parts.indexOf("Cellar");
  if (cellarIndex > 0 && parts.length > cellarIndex + 2) {
    return path.join(path.sep, ...parts.slice(1, cellarIndex + 3));
  }

  const installsIndex = parts.findIndex(
    (part, index) => part === "installs" && parts[index - 1] === "mise",
  );
  if (installsIndex > 0 && parts.length > installsIndex + 2) {
    return path.join(path.sep, ...parts.slice(1, installsIndex + 3));
  }
  return undefined;
}

function runtimeLibraryPaths(executable: string): string[] {
  const readablePaths: string[] = [];
  const visited = new Set<string>();
  const pending = [executable];
  while (pending.length > 0 && visited.size < 128) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);

    let output: string;
    try {
      output = execFileSync("/usr/bin/otool", ["-L", current], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      continue;
    }
    for (const line of output.split("\n").slice(1)) {
      const dependency = line.trim().split(" (")[0];
      if (dependency === undefined || !path.isAbsolute(dependency)) continue;
      try {
        const resolved = realpathSync(dependency);
        readablePaths.push(
          dependency,
          path.dirname(dependency),
          resolved,
          path.dirname(resolved),
        );
        const installationRoot = versionedRuntimeRoot(resolved);
        if (installationRoot !== undefined)
          readablePaths.push(installationRoot);
        pending.push(resolved);
      } catch {
        // Libraries in the macOS dyld cache need no filesystem rule.
      }
    }
  }
  return readablePaths;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

/** Resolve an executable from PATH without ever selecting repository content. */
export function resolveTrustedExecutable(
  name: string,
  env: ReviewerEnv,
  repositoryRoot: string,
): TrustedExecutable | null {
  const resolvedRoot = realpathSync(repositoryRoot);
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      const resolved = realpathSync(candidate);
      if (
        isWithin(resolvedRoot, path.resolve(candidate)) ||
        isWithin(resolvedRoot, resolved)
      ) {
        continue;
      }
      const installationRoot = versionedRuntimeRoot(resolved);
      return {
        executable: resolved,
        readablePaths: [
          ...new Set([
            path.dirname(candidate),
            candidate,
            path.dirname(resolved),
            resolved,
            ...(installationRoot === undefined ? [] : [installationRoot]),
            ...runtimeLibraryPaths(resolved),
          ]),
        ],
      };
    } catch {
      // Keep searching for an executable outside the repository boundary.
    }
  }
  return null;
}

/** PATH for trusted runtimes and basic system helpers, never workspace paths. */
export function trustedRuntimePath(
  runtimes: readonly TrustedExecutable[],
): string {
  return [
    ...new Set([
      ...runtimes.flatMap(({ executable }) => path.dirname(executable)),
      ...SYSTEM_EXECUTABLE_PATHS,
    ]),
  ].join(path.delimiter);
}
