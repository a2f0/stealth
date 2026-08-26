import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  assertNoMaterializedPathCollisions,
  decodeGitPath,
  splitNulDelimitedGitOutput,
} from "../git/gitPaths";
import {
  resolveTrustedExecutable,
  type TrustedExecutable,
  trustedRuntimePath,
} from "../review/trustedExecutable";

const SAFE_PREFLIGHT_ENVIRONMENT = new Set(["LANG", "LC_ALL", "TERM", "TZ"]);
const MUTABLE_DEPENDENCY_CACHE_NAMES = new Set([
  ".astro",
  ".cache",
  ".turbo",
  ".vite",
  ".vite-temp",
]);
const MAX_PREFLIGHT_BYTES = 64 * 1024 * 1024;
const MAX_PREFLIGHT_FILES = 20_000;

interface PreflightFile {
  readonly contents: Buffer;
  readonly executable: boolean;
  readonly filePath: string;
}

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

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

function resolveTemporaryParent(
  candidate: string | undefined,
  repositoryRoot: string,
): string {
  const fallback = realpathSync("/private/tmp");
  if (candidate === undefined || !path.isAbsolute(candidate)) return fallback;
  try {
    const resolved = realpathSync(candidate);
    return isWithin(realpathSync(repositoryRoot), resolved)
      ? fallback
      : resolved;
  } catch {
    return fallback;
  }
}

/** A macOS Seatbelt profile that cannot read user credentials or mutate Git. */
export function buildPreflightSandboxProfile(
  checkoutRoot: string,
  temporaryHome: string,
  runtimes: readonly TrustedExecutable[],
  readonlyPaths: readonly string[] = [],
  protectedPaths: readonly string[] = [],
) {
  const root = path.resolve(checkoutRoot);
  const isolatedHome = path.resolve(temporaryHome);
  const traversalDirectories = [
    ...ancestors(root),
    ...ancestors(isolatedHome),
    ...readonlyPaths.flatMap(ancestors),
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
    ...readonlyPaths,
    ...runtimes.flatMap(({ readablePaths }) => readablePaths),
  ];
  const deniedWrites = [
    path.join(root, ".git"),
    ...readonlyPaths,
    ...protectedPaths,
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
    `(deny file-write* ${pathRules("subpath", deniedWrites)})`,
    // Test tooling may use Unix sockets, but access stays inside the disposable
    // home. Host TCP services, including loopback, remain under the default
    // deny.
    `(allow network-bind network-outbound (subpath ${seatbeltString(isolatedHome)}))`,
  ].join("\n");
}

function safeGitEnvironment(
  source: NodeJS.ProcessEnv,
  repositoryRoot: string,
  temporaryHome: string,
  runtimes: readonly TrustedExecutable[],
) {
  return {
    ...buildPreflightEnvironment(
      source,
      repositoryRoot,
      temporaryHome,
      runtimes,
    ),
    GIT_AUTHOR_EMAIL: "preflight@localhost",
    GIT_AUTHOR_NAME: "Preflight",
    GIT_COMMITTER_EMAIL: "preflight@localhost",
    GIT_COMMITTER_NAME: "Preflight",
  };
}

function preflightPaths(
  repositoryRoot: string,
  git: TrustedExecutable,
  environment: NodeJS.ProcessEnv,
): string[] {
  const output = execFileSync(
    git.executable,
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "credential.helper=",
      "-C",
      repositoryRoot,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ],
    { env: environment, maxBuffer: MAX_PREFLIGHT_BYTES },
  );
  const paths = parsePreflightPaths(output);
  if (paths.length > MAX_PREFLIGHT_FILES) {
    throw new Error(
      `Preflight checkout contains ${paths.length} files; limit is ${MAX_PREFLIGHT_FILES}.`,
    );
  }
  return paths;
}

export function parsePreflightPaths(output: Buffer): string[] {
  return splitNulDelimitedGitOutput(output, "Preflight path listing").map(
    (pathBytes) => decodeGitPath(pathBytes, "Preflight path"),
  );
}

function preflightDestination(checkoutRoot: string, filePath: string): string {
  const parts = filePath.split("/");
  if (
    filePath.length === 0 ||
    filePath.includes("\\") ||
    path.posix.isAbsolute(filePath) ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe preflight path: ${JSON.stringify(filePath)}`);
  }
  const root = path.resolve(checkoutRoot);
  const destination = path.resolve(root, ...parts);
  if (!destination.startsWith(`${root}${path.sep}`)) {
    throw new Error(
      `Preflight path escaped checkout: ${JSON.stringify(filePath)}`,
    );
  }
  return destination;
}

function assertNoSymlinkAncestors(
  repositoryRoot: string,
  filePath: string,
): boolean {
  const parts = filePath.split("/");
  let current = repositoryRoot;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(
        `Preflight path has an unsafe ancestor: ${JSON.stringify(filePath)}`,
      );
    }
  }
  return true;
}

function readPreflightFile(
  repositoryRoot: string,
  filePath: string,
): PreflightFile | null {
  if (!assertNoSymlinkAncestors(repositoryRoot, filePath)) return null;
  const source = path.join(repositoryRoot, ...filePath.split("/"));
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  let contents: Buffer;
  if (stat.isSymbolicLink()) {
    contents = Buffer.from(readlinkSync(source));
  } else if (stat.isFile()) {
    contents = readFileSync(source);
  } else if (stat.isDirectory()) {
    contents = Buffer.from("submodule working tree\n");
  } else {
    throw new Error(`Unsupported preflight file: ${JSON.stringify(filePath)}`);
  }
  return {
    contents,
    executable: stat.isFile() && (stat.mode & 0o111) !== 0,
    filePath,
  };
}

/** Snapshot tracked and non-ignored working files without following symlinks. */
function materializePreflightCheckout(
  repositoryRoot: string,
  checkoutRoot: string,
  git: TrustedExecutable,
  environment: NodeJS.ProcessEnv,
): void {
  const files: PreflightFile[] = [];
  let totalBytes = 0;
  const filePaths = preflightPaths(repositoryRoot, git, environment);
  for (const filePath of filePaths) {
    preflightDestination(checkoutRoot, filePath);
  }
  assertNoMaterializedPathCollisions(filePaths, "Preflight checkout");

  for (const filePath of filePaths) {
    const file = readPreflightFile(repositoryRoot, filePath);
    if (file === null) continue;
    totalBytes += file.contents.byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_PREFLIGHT_BYTES) {
      throw new Error(
        `Preflight checkout exceeds the ${MAX_PREFLIGHT_BYTES}-byte materialization limit.`,
      );
    }
    files.push(file);
  }

  mkdirSync(checkoutRoot, { recursive: true });
  for (const file of files) {
    const destination = preflightDestination(checkoutRoot, file.filePath);
    const mode = file.executable ? 0o755 : 0o644;
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, file.contents, { mode });
    chmodSync(destination, mode);
  }
}

function initializeSnapshotRepository(
  checkoutRoot: string,
  git: TrustedExecutable,
  environment: NodeJS.ProcessEnv,
) {
  const invoke = (arguments_: readonly string[]) =>
    execFileSync(git.executable, arguments_, {
      cwd: checkoutRoot,
      env: environment,
      stdio: "ignore",
    });
  invoke(["init", "--quiet"]);
  invoke(["-c", "core.hooksPath=/dev/null", "add", "-f", "--all"]);
  invoke([
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--quiet",
    "--no-gpg-sign",
    "--no-verify",
    "-m",
    "preflight snapshot",
  ]);
}

function childDirectories(parent: string): string[] {
  if (!existsSync(parent) || !lstatSync(parent).isDirectory()) return [];
  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(parent, entry.name));
}

function pathExists(candidate: string): boolean {
  try {
    lstatSync(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function mountDependencyFacade(source: string, destination: string): string {
  const resolved = realpathSync(source);
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(resolved, { withFileTypes: true })) {
    const mountedEntry = path.join(destination, entry.name);
    if (MUTABLE_DEPENDENCY_CACHE_NAMES.has(entry.name)) {
      mkdirSync(mountedEntry, { recursive: true });
    } else {
      symlinkSync(path.join(resolved, entry.name), mountedEntry);
    }
  }
  return resolved;
}

/** Link only known dependency caches; the sandbox grants them read-only access. */
function mountPreflightDependencies(
  repositoryRoot: string,
  checkoutRoot: string,
): string[] {
  const nodeModules = [
    path.join(repositoryRoot, "node_modules"),
    ...["apps", "packages"].flatMap((directory) =>
      childDirectories(path.join(repositoryRoot, directory)).map((child) =>
        path.join(child, "node_modules"),
      ),
    ),
  ];
  const readonlyPaths: string[] = [];
  for (const candidate of nodeModules) {
    if (!existsSync(candidate) || !lstatSync(candidate).isDirectory()) continue;
    const relative = path.relative(repositoryRoot, candidate);
    const destination = path.join(checkoutRoot, relative);
    if (pathExists(destination)) continue;
    mkdirSync(path.dirname(destination), { recursive: true });
    readonlyPaths.push(mountDependencyFacade(candidate, destination));
  }
  const terraformCaches = childDirectories(
    path.join(repositoryRoot, "terraform", "stacks"),
  ).map((child) => path.join(child, ".terraform"));
  for (const candidate of terraformCaches) {
    if (!existsSync(candidate) || !lstatSync(candidate).isDirectory()) continue;
    const destination = path.join(
      checkoutRoot,
      path.relative(repositoryRoot, candidate),
    );
    if (pathExists(destination)) continue;
    mkdirSync(path.dirname(destination), { recursive: true });
    const resolved = realpathSync(candidate);
    symlinkSync(resolved, destination, "dir");
    readonlyPaths.push(resolved);
  }
  return [...new Set(readonlyPaths)];
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

function resolvePreflightRuntimes(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
): [TrustedExecutable, TrustedExecutable] {
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
  return [bun, git];
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
  const [bun, git] = resolvePreflightRuntimes(repositoryRoot, environment);
  const runtimes = [bun, git];

  const temporaryParent = resolveTemporaryParent(
    Reflect.get(environment, "TMPDIR"),
    repositoryRoot,
  );
  const temporaryDirectory = mkdtempSync(
    path.join(temporaryParent, "agent-tool-preflight-"),
  );
  const temporaryRoot = realpathSync(temporaryDirectory);
  const temporaryHome = path.join(temporaryRoot, "home");
  const checkoutRoot = path.join(temporaryRoot, "checkout");
  mkdirSync(temporaryHome, { recursive: true });
  try {
    const gitEnvironment = safeGitEnvironment(
      environment,
      checkoutRoot,
      temporaryHome,
      runtimes,
    );
    materializePreflightCheckout(
      repositoryRoot,
      checkoutRoot,
      git,
      gitEnvironment,
    );
    initializeSnapshotRepository(checkoutRoot, git, gitEnvironment);
    const readonlyPaths = mountPreflightDependencies(
      repositoryRoot,
      checkoutRoot,
    );
    const result = spawnSync(
      "/usr/bin/sandbox-exec",
      [
        "-p",
        buildPreflightSandboxProfile(
          checkoutRoot,
          temporaryHome,
          runtimes,
          readonlyPaths,
          [repositoryRoot],
        ),
        bun.executable,
        "--no-env-file",
        "run",
        script,
        ...scriptArguments,
      ],
      {
        cwd: checkoutRoot,
        env: buildPreflightEnvironment(
          environment,
          checkoutRoot,
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
