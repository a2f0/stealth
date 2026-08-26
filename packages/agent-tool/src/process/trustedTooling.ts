import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import {
  resolveTrustedExecutable,
  type TrustedExecutable,
  trustedRuntimePath,
} from "../review/trustedExecutable";

export type ToolCommand = "gh" | "git";

const TOOL_ENV_ALLOWLIST = new Set([
  "ALL_PROXY",
  "GH_CONFIG_DIR",
  "GH_ENTERPRISE_TOKEN",
  "GH_HOST",
  "GH_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GITHUB_TOKEN",
  "HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LC_ALL",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "SSH_AUTH_SOCK",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "all_proxy",
  "https_proxy",
  "http_proxy",
  "no_proxy",
]);

interface TrustedTooling {
  readonly commands: Record<ToolCommand, TrustedExecutable>;
  readonly environment: NodeJS.ProcessEnv;
}

let tooling: TrustedTooling | null = null;

/** Build the minimal environment inherited by trusted Git/GitHub subprocesses. */
export function buildTrustedToolEnvironment(
  env: NodeJS.ProcessEnv,
  runtimes: readonly TrustedExecutable[],
): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(
        ([key, value]) => TOOL_ENV_ALLOWLIST.has(key) && value !== undefined,
      ),
    ),
    GCM_INTERACTIVE: "never",
    GIT_ASKPASS: "/usr/bin/false",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    PATH: trustedRuntimePath(runtimes),
  };
}

function repositoryBoundary(startDirectory: string): string {
  let candidate = realpathSync(startDirectory);
  while (true) {
    if (existsSync(path.join(candidate, ".git"))) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) return realpathSync(startDirectory);
    candidate = parent;
  }
}

function requireTrustedExecutable(
  name: ToolCommand,
  env: NodeJS.ProcessEnv,
  repositoryRoot: string,
): TrustedExecutable {
  const resolved = resolveTrustedExecutable(name, env, repositoryRoot);
  if (resolved === null) {
    throw new Error(
      `No trusted ${name} executable was found outside the repository.`,
    );
  }
  return resolved;
}

/** Resolve the repository and freeze trusted Git/GitHub process boundaries. */
export function initializeTrustedTooling(
  startDirectory = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const boundary = repositoryBoundary(startDirectory);
  const bootstrapGit = requireTrustedExecutable("git", env, boundary);
  const bootstrapEnvironment = buildTrustedToolEnvironment(env, [bootstrapGit]);
  const rootDir = realpathSync(
    execFileSync(bootstrapGit.executable, ["rev-parse", "--show-toplevel"], {
      cwd: startDirectory,
      encoding: "utf8",
      env: bootstrapEnvironment,
    }).trim(),
  );
  const git = requireTrustedExecutable("git", env, rootDir);
  const gh = requireTrustedExecutable("gh", env, rootDir);
  tooling = {
    commands: { gh, git },
    environment: buildTrustedToolEnvironment(env, [git, gh]),
  };
  return rootDir;
}

export function toolExecutable(command: ToolCommand): string {
  if (tooling === null) initializeTrustedTooling();
  if (tooling === null)
    throw new Error("Trusted tooling could not initialize.");
  return tooling.commands[command].executable;
}

export function toolEnvironment(
  additions: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  if (tooling === null) initializeTrustedTooling();
  if (tooling === null)
    throw new Error("Trusted tooling could not initialize.");
  return { ...tooling.environment, ...additions };
}
