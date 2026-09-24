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
const DEFAULT_PREFLIGHT_TIMEOUT_MILLISECONDS = 10 * 60 * 1_000;
const DEFAULT_MAX_PREFLIGHT_WRITABLE_BYTES = 512 * 1024 * 1024;
const MAX_PREFLIGHT_SINGLE_FILE_BYTES = 128 * 1024 * 1024;
const PREFLIGHT_STORAGE_LIMIT_MARKER = "storage-limit-exceeded";

interface PreflightLimits {
  readonly maxWritableBytes: number;
  readonly timeoutMilliseconds: number;
}

const PREFLIGHT_SUPERVISOR = `
limit_kib=$1
file_blocks=$2
writable_root=$3
limit_marker=$4
shift 4

terminate_group() {
  trap - TERM INT HUP
  if [ -n "$child" ]; then
    kill -TERM "-$child" 2>/dev/null || true
    /bin/sleep 1
    kill -KILL "-$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  exit 143
}

check_storage() {
  used_kib=$(/usr/bin/du -sk "$writable_root" | /usr/bin/awk '{print $1}') || return 1
  if [ "$used_kib" -gt "$limit_kib" ]; then
    /usr/bin/touch "$limit_marker"
    terminate_group
    return 2
  fi
}

child=""
trap terminate_group TERM INT HUP
ulimit -f "$file_blocks" || exit 70
set -m
"$@" &
child=$!
while kill -0 "$child" 2>/dev/null; do
  check_storage
  storage_status=$?
  if [ "$storage_status" -ne 0 ]; then
    wait "$child" 2>/dev/null || true
    exit 71
  fi
  /bin/sleep 0.25
done
wait "$child" 2>/dev/null
status=$?
check_storage
[ "$?" -eq 0 ] || exit 71
exit "$status"
`;

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
    "/usr/bin",
    "/usr/lib",
    "/usr/libexec",
    "/usr/share",
    "/bin",
    "/sbin",
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
  const deniedConfigurationReads = [
    "/Library/Application Support",
    "/Library/Preferences",
    "/opt/homebrew/etc",
    "/opt/homebrew/var",
    "/usr/local/etc",
    "/usr/local/var",
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
    `(deny file-read* ${pathRules("subpath", deniedConfigurationReads)})`,
    `(allow file-write* (subpath ${seatbeltString(root)}) (subpath ${seatbeltString(isolatedHome)}))`,
    `(deny file-write* ${pathRules("subpath", deniedWrites)})`,
    // Test tooling may use Unix sockets, but access stays inside the disposable
    // home. Host TCP services, including loopback, remain under the default
    // deny.
    `(allow network-bind network-outbound (subpath ${seatbeltString(isolatedHome)}))`,
  ].join("\n");
}

function resolvePreflightLimits(
  limits: Partial<PreflightLimits>,
): PreflightLimits {
  const resolved = {
    maxWritableBytes:
      limits.maxWritableBytes ?? DEFAULT_MAX_PREFLIGHT_WRITABLE_BYTES,
    timeoutMilliseconds:
      limits.timeoutMilliseconds ?? DEFAULT_PREFLIGHT_TIMEOUT_MILLISECONDS,
  };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Preflight ${name} must be a positive safe integer.`);
    }
  }
  return resolved;
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

interface SnapshotRoots {
  readonly checkoutRoot: string;
  readonly repositoryRoot: string;
}

/**
 * Where a mounted dependency entry should point. Workspace packages are linked
 * into the repository's own source tree, which the sandbox cannot read, so
 * they resolve to the snapshot's copy instead; installed packages keep their
 * read-only location.
 */
function dependencyTarget(entryPath: string, roots: SnapshotRoots): string {
  if (!lstatSync(entryPath).isSymbolicLink()) return entryPath;
  let target: string;
  try {
    target = realpathSync(entryPath);
  } catch {
    return entryPath;
  }
  const relative = path.relative(roots.repositoryRoot, target);
  if (
    relative === "" ||
    !isWithin(roots.repositoryRoot, target) ||
    relative.split(path.sep).includes("node_modules")
  ) {
    return entryPath;
  }
  const snapshotCopy = path.join(roots.checkoutRoot, relative);
  return pathExists(snapshotCopy) ? snapshotCopy : entryPath;
}

function mountDependencyFacade(
  source: string,
  destination: string,
  roots: SnapshotRoots,
): string {
  const resolved = realpathSync(source);
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(resolved, { withFileTypes: true })) {
    const mountedEntry = path.join(destination, entry.name);
    const sourceEntry = path.join(resolved, entry.name);
    if (MUTABLE_DEPENDENCY_CACHE_NAMES.has(entry.name)) {
      mkdirSync(mountedEntry, { recursive: true });
    } else if (entry.isDirectory() && entry.name.startsWith("@")) {
      // Scopes are mirrored per package so scoped workspace links resolve too.
      mkdirSync(mountedEntry);
      for (const scoped of readdirSync(sourceEntry)) {
        symlinkSync(
          dependencyTarget(path.join(sourceEntry, scoped), roots),
          path.join(mountedEntry, scoped),
        );
      }
    } else {
      symlinkSync(dependencyTarget(sourceEntry, roots), mountedEntry);
    }
  }
  return resolved;
}

/** Link only known dependency caches; the sandbox grants them read-only access. */
export function mountPreflightDependencies(
  repositoryRoot: string,
  checkoutRoot: string,
): string[] {
  const roots = {
    checkoutRoot,
    repositoryRoot: realpathSync(repositoryRoot),
  };
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
    readonlyPaths.push(mountDependencyFacade(candidate, destination, roots));
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
): {
  bun: TrustedExecutable;
  git: TrustedExecutable;
  runtimes: TrustedExecutable[];
} {
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
  const optionalRuntimes = [
    "gh",
    "node",
    "gpg",
    "gpg-agent",
    "gpgconf",
    "shellcheck",
    "terraform",
    "tflint",
  ]
    .map((name) => resolveTrustedExecutable(name, environment, repositoryRoot))
    .filter((runtime): runtime is TrustedExecutable => runtime !== null);
  const runtimes = [
    ...new Map(
      [bun, git, ...optionalRuntimes].map((runtime) => [
        runtime.executable,
        runtime,
      ]),
    ).values(),
  ];
  return { bun, git, runtimes };
}

function executePreflightScript(params: {
  bun: TrustedExecutable;
  checkoutRoot: string;
  environment: NodeJS.ProcessEnv;
  limits: PreflightLimits;
  readonlyPaths: readonly string[];
  repositoryRoot: string;
  runtimes: readonly TrustedExecutable[];
  script: string;
  scriptArguments: readonly string[];
  temporaryHome: string;
  temporaryRoot: string;
}): number {
  const {
    bun,
    checkoutRoot,
    environment,
    limits,
    readonlyPaths,
    repositoryRoot,
    runtimes,
    script,
    scriptArguments,
    temporaryHome,
    temporaryRoot,
  } = params;
  const storageLimitMarker = path.join(
    temporaryRoot,
    PREFLIGHT_STORAGE_LIMIT_MARKER,
  );
  const maximumFileBytes = Math.min(
    limits.maxWritableBytes,
    MAX_PREFLIGHT_SINGLE_FILE_BYTES,
  );
  const result = spawnSync(
    "/bin/sh",
    [
      "-c",
      PREFLIGHT_SUPERVISOR,
      "preflight-supervisor",
      String(Math.ceil(limits.maxWritableBytes / 1_024)),
      String(Math.ceil(maximumFileBytes / 512)),
      temporaryRoot,
      storageLimitMarker,
      "/usr/bin/sandbox-exec",
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
      killSignal: "SIGTERM",
      stdio: "inherit",
      timeout: limits.timeoutMilliseconds,
    },
  );
  if (existsSync(storageLimitMarker)) {
    throw new Error(
      `Preflight exceeded its ${limits.maxWritableBytes}-byte writable storage limit.`,
    );
  }
  if (result.error !== undefined) {
    if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      throw new Error(
        `Preflight exceeded its ${limits.timeoutMilliseconds}-millisecond timeout.`,
      );
    }
    throw result.error;
  }
  if (result.signal !== null) {
    throw new Error(`Preflight terminated by signal ${result.signal}.`);
  }
  return result.status ?? 1;
}

/** Run a branch-controlled script without credentials or external network. */
export function runPreflight(
  repositoryRoot: string,
  script: string | undefined,
  scriptArguments: readonly string[] = [],
  environment: NodeJS.ProcessEnv = process.env,
  limits: Partial<PreflightLimits> = {},
) {
  if (script === undefined || !/^[a-z0-9:_-]+$/.test(script)) {
    throw new Error("runPreflight requires a package script name.");
  }
  if (process.platform !== "darwin") {
    throw new Error(
      "Credential-free preflight currently requires macOS Seatbelt; refusing to run unsandboxed.",
    );
  }
  const { bun, git, runtimes } = resolvePreflightRuntimes(
    repositoryRoot,
    environment,
  );
  const resolvedLimits = resolvePreflightLimits(limits);

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
    return executePreflightScript({
      bun,
      checkoutRoot,
      environment,
      limits: resolvedLimits,
      readonlyPaths,
      repositoryRoot,
      runtimes,
      script,
      scriptArguments,
      temporaryHome,
      temporaryRoot,
    });
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}
