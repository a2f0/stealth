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
      return {
        executable: resolved,
        readablePaths: [
          ...new Set([
            path.dirname(candidate),
            candidate,
            path.dirname(resolved),
            resolved,
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
