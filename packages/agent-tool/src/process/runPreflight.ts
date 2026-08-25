import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";

import {
  resolveTrustedExecutable,
  type TrustedExecutable,
  trustedRuntimePath,
} from "../review/trustedExecutable";

const SAFE_PREFLIGHT_ENVIRONMENT = new Set(["LANG", "LC_ALL", "TERM", "TZ"]);

function seatbeltString(value: string) {
  return JSON.stringify(value);
}

function ancestors(directory: string) {
  const values: string[] = [];
  let current = path.dirname(directory);
  while (current !== path.dirname(current)) {
    values.push(current);
    current = path.dirname(current);
  }
  return values.reverse();
}

function pathRules(kind: "literal" | "subpath", paths: readonly string[]) {
  return [...new Set(paths)]
    .map((entry) => `(${kind} ${seatbeltString(entry)})`)
    .join(" ");
}

/** A macOS Seatbelt profile that cannot read user credentials or mutate Git. */
export function buildPreflightSandboxProfile(
  repositoryRoot: string,
  temporaryHome: string,
  runtimes: readonly TrustedExecutable[],
) {
  const root = path.resolve(repositoryRoot);
  const isolatedHome = path.resolve(temporaryHome);
  const traversalDirectories = [
    ...ancestors(root),
    ...ancestors(isolatedHome),
    ...runtimes.flatMap(({ readablePaths }) =>
      readablePaths.flatMap(ancestors),
    ),
  ];
  const readableTrees = [
    "/System",
    "/Library",
    "/usr",
    "/bin",
    "/sbin",
    "/opt/homebrew",
    "/usr/local",
    "/private/etc/ssl",
    root,
    isolatedHome,
    ...runtimes.flatMap(({ readablePaths }) => readablePaths),
  ];
  return [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")',
    "(allow process*)",
    "(allow signal (target children))",
    "(allow sysctl-read)",
    // Tools may stat an ignored symlink before excluding it. Metadata alone
    // cannot reveal the contents of a credential file or directory.
    "(allow file-read-metadata)",
    `(allow file-read* ${pathRules("literal", traversalDirectories)} ${pathRules("subpath", readableTrees)})`,
    `(allow file-write* (subpath ${seatbeltString(root)}) (subpath ${seatbeltString(isolatedHome)}))`,
    `(deny file-write* (subpath ${seatbeltString(path.join(root, ".git"))}) (subpath ${seatbeltString(path.join(root, "node_modules"))}))`,
    // Terraform and Miniflare use local plugin/test sockets. Only loopback and
    // Unix sockets under the isolated home escape the external-network deny.
    `(allow network-bind network-outbound (subpath ${seatbeltString(isolatedHome)}))`,
    '(allow network-bind (local ip "*:*"))',
    "(allow network-inbound (local ip))",
    '(allow network-bind (local ip "localhost:*"))',
    '(allow network-outbound (remote ip "localhost:*"))',
    "(deny network*)",
  ].join("\n");
}

export function buildPreflightEnvironment(
  source: NodeJS.ProcessEnv,
  repositoryRoot: string,
  temporaryHome: string,
  runtimes: readonly TrustedExecutable[],
) {
  return {
    ...Object.fromEntries(
      Object.entries(source).filter(
        ([key, value]) =>
          SAFE_PREFLIGHT_ENVIRONMENT.has(key) && value !== undefined,
      ),
    ),
    CI: "1",
    GCM_INTERACTIVE: "never",
    GIT_ASKPASS: "/usr/bin/false",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_VALUE_1: "",
    GIT_TERMINAL_PROMPT: "0",
    HOME: temporaryHome,
    PATH: trustedRuntimePath(runtimes),
    PWD: repositoryRoot,
    TEARLEADS_PREFLIGHT_OFFLINE: "1",
    TURBO_ENV_MODE: "loose",
    TMPDIR: temporaryHome,
    SSH_ASKPASS: "/usr/bin/false",
    XDG_CONFIG_HOME: temporaryHome,
  };
}

/** Run a branch-controlled script without credentials or external network. */
export function runPreflight(
  repositoryRoot: string,
  script: string | undefined,
  scriptArguments: readonly string[] = [],
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (script === undefined || !/^[a-z0-9:_-]+$/.test(script)) {
    throw new Error("runPreflight requires a package script name.");
  }
  if (process.platform !== "darwin") {
    throw new Error(
      "Credential-free preflight currently requires macOS Seatbelt; refusing to run unsandboxed.",
    );
  }
  const bun = resolveTrustedExecutable("bun", environment, repositoryRoot);
  if (bun === null) {
    throw new Error(
      "No trusted bun executable was found outside the repository.",
    );
  }
  const git = resolveTrustedExecutable("git", environment, repositoryRoot);
  if (git === null) {
    throw new Error(
      "No trusted git executable was found outside the repository.",
    );
  }
  const runtimes = [bun, git];

  const temporaryDirectory = mkdtempSync("/private/tmp/agent-tool-preflight-");
  const temporaryHome = realpathSync(temporaryDirectory);
  try {
    const result = spawnSync(
      "/usr/bin/sandbox-exec",
      [
        "-p",
        buildPreflightSandboxProfile(repositoryRoot, temporaryHome, runtimes),
        bun.executable,
        "--no-env-file",
        "run",
        script,
        ...scriptArguments,
      ],
      {
        cwd: repositoryRoot,
        env: buildPreflightEnvironment(
          environment,
          repositoryRoot,
          temporaryHome,
          runtimes,
        ),
        stdio: "inherit",
      },
    );
    if (result.error !== undefined) throw result.error;
    if (result.signal !== null) {
      throw new Error(`Preflight terminated by signal ${result.signal}.`);
    }
    return result.status ?? 1;
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}
