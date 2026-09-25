import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveTrustedExecutable,
  type TrustedExecutable,
} from "../review/trustedExecutable";
import {
  buildPreflightEnvironment,
  buildPreflightSandboxProfile,
  mountPreflightDependencies,
  parsePreflightPaths,
  runPreflight,
} from "./runPreflight";

const runtime: TrustedExecutable = {
  executable: "/trusted/bun/bin/bun",
  readablePaths: ["/trusted/bun/bin", "/trusted/bun/bin/bun"],
};

function assertExternalServerReachable(host: string, port: number) {
  return new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
    socket.setTimeout(3_000, () => {
      socket.destroy(new Error("External test address was not reachable."));
    });
  });
}

/**
 * A Bun-style workspace: packages/web links @scope/lib to packages/lib and an
 * installed @scope/dep into the root store.
 */
function createWorkspaceFixture(repositoryRoot: string) {
  const library = path.join(repositoryRoot, "packages", "lib");
  const store = path.join(repositoryRoot, "node_modules", ".store", "dep");
  const scope = path.join(
    repositoryRoot,
    "packages",
    "web",
    "node_modules",
    "@scope",
  );
  mkdirSync(library, { recursive: true });
  mkdirSync(store, { recursive: true });
  mkdirSync(scope, { recursive: true });
  writeFileSync(
    path.join(library, "package.json"),
    `${JSON.stringify({ main: "index.ts", name: "@scope/lib" })}\n`,
  );
  writeFileSync(
    path.join(library, "index.ts"),
    'export const library = "workspace library";\n',
  );
  writeFileSync(
    path.join(store, "package.json"),
    `${JSON.stringify({ main: "index.js", name: "@scope/dep" })}\n`,
  );
  writeFileSync(
    path.join(store, "index.js"),
    'export const dependency = "installed dependency";\n',
  );
  symlinkSync("../../../../packages/lib", path.join(scope, "lib"));
  symlinkSync("../../../../node_modules/.store/dep", path.join(scope, "dep"));
  return { library, scope, store };
}

function commitFixture(repositoryRoot: string) {
  const git = resolveTrustedExecutable("git", process.env, repositoryRoot);
  if (git === null) throw new Error("Trusted Git is required for this test.");
  const invokeGit = (arguments_: readonly string[]) =>
    execFileSync(git.executable, arguments_, {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      stdio: "ignore",
    });
  invokeGit(["init", "--quiet"]);
  invokeGit(["-c", "core.hooksPath=/dev/null", "add", "--all"]);
  invokeGit([
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "user.name=Preflight Test",
    "-c",
    "user.email=preflight-test@localhost",
    "commit",
    "--quiet",
    "--no-gpg-sign",
    "--no-verify",
    "-m",
    "fixture",
  ]);
}

test("preflight strips credentials and contributor-controlled process options", () => {
  const environment = buildPreflightEnvironment(
    {
      BUN_OPTIONS: "--preload=/repo/steal.ts",
      CF_API_TOKEN: "cloudflare-secret",
      GH_TOKEN: "github-secret",
      HTTP_PROXY: "https://proxy.invalid",
      LANG: "en_US.UTF-8",
      NODE_OPTIONS: "--import=/repo/steal.mjs",
      OPENAI_API_KEY: "reviewer-secret",
      PATH: "/repo/bin:/usr/bin",
      SSH_AUTH_SOCK: "/private/tmp/agent.sock",
    },
    "/workspace/repo",
    "/private/tmp/preflight-home",
    [runtime],
  );

  expect(environment).toMatchObject({
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
    HOME: "/private/tmp/preflight-home",
    LANG: "en_US.UTF-8",
    PWD: "/workspace/repo",
    SSH_ASKPASS: "/usr/bin/false",
    TEARLEADS_PREFLIGHT_OFFLINE: "1",
    TMPDIR: "/private/tmp/preflight-home",
    TURBO_ENV_MODE: "loose",
    XDG_CONFIG_HOME: "/private/tmp/preflight-home",
  });
  expect(Reflect.get(environment, "BUN_OPTIONS")).toBeUndefined();
  expect(Reflect.get(environment, "CF_API_TOKEN")).toBeUndefined();
  expect(Reflect.get(environment, "GH_TOKEN")).toBeUndefined();
  expect(Reflect.get(environment, "HTTP_PROXY")).toBeUndefined();
  expect(Reflect.get(environment, "NODE_OPTIONS")).toBeUndefined();
  expect(Reflect.get(environment, "OPENAI_API_KEY")).toBeUndefined();
  expect(Reflect.get(environment, "SSH_AUTH_SOCK")).toBeUndefined();
  expect(environment.PATH).not.toContain("/repo/bin");
});

test("preflight denies external network, Git writes, and dependency poisoning", () => {
  const profile = buildPreflightSandboxProfile(
    "/private/tmp/preflight-home/checkout",
    "/private/tmp/preflight-home",
    [runtime],
    ["/Users/example/repo/packages/api/node_modules"],
    ["/Users/example/repo"],
  );

  // The default deny blocks every TCP peer, including host loopback. A blanket
  // explicit deny would also override the isolated Unix socket allowance.
  expect(profile).not.toContain("(deny network*)");
  expect(profile).toContain('(import "system.sb")');
  expect(profile).toContain("(allow signal (target children))");
  expect(profile).toContain(
    '(allow network-bind network-outbound (subpath "/private/tmp/preflight-home"))',
  );
  expect(profile).not.toContain('(local ip "*:*")');
  expect(profile).not.toContain("network-inbound (local ip)");
  expect(profile).not.toContain('(local ip "localhost:*")');
  expect(profile).not.toContain('(remote ip "localhost:*")');
  expect(profile).not.toContain("network-inbound");
  expect(profile).not.toContain("(local ip");
  expect(profile).not.toContain("(remote ip");
  expect(profile).toContain("(allow file-read-metadata)");
  expect(profile).toContain(
    '(deny file-write* (subpath "/private/tmp/preflight-home/checkout/.git") (subpath "/Users/example/repo/packages/api/node_modules") (subpath "/Users/example/repo"))',
  );
  expect(profile).toContain(
    '(subpath "/Users/example/repo/packages/api/node_modules")',
  );
  expect(profile).toContain('(subpath "/private/tmp/preflight-home")');
  expect(profile).not.toContain('(subpath "/Users/example")');
  expect(profile).not.toContain('(subpath "/Library")');
  expect(profile).not.toContain('(subpath "/opt/homebrew")');
  expect(profile).not.toContain('(subpath "/usr")');
  expect(profile).not.toContain('(subpath "/usr/local")');
  expect(profile).toContain(
    '(deny file-read* (subpath "/Library/Application Support") (subpath "/Library/Preferences") (subpath "/opt/homebrew/etc") (subpath "/opt/homebrew/var") (subpath "/usr/local/etc") (subpath "/usr/local/var"))',
  );
});

test("preflight rejects Git paths that are not round-trippable UTF-8", () => {
  const output = Buffer.concat([
    Buffer.from("valid.ts\0invalid-"),
    Buffer.from([0xff, 0]),
  ]);
  expect(() => parsePreflightPaths(output)).toThrow("not valid UTF-8");
  expect(() => parsePreflightPaths(Buffer.from("missing-terminator"))).toThrow(
    "not NUL-terminated",
  );
});

test.skipIf(
  process.platform !== "darwin" ||
    Reflect.get(process.env, "TEARLEADS_PREFLIGHT_OFFLINE") === "1",
)(
  "preflight isolates files and networking while permitting isolated Unix sockets",
  async () => {
    const repositoryRoot = mkdtempSync(
      path.join(tmpdir(), "agent-tool-preflight-source-"),
    );
    const rootDependencies = path.join(repositoryRoot, "node_modules");
    const nestedDependencies = path.join(
      repositoryRoot,
      "packages",
      "api",
      "node_modules",
    );
    const sourceFile = path.join(repositoryRoot, "source.txt");
    const ignoredFile = path.join(repositoryRoot, ".env");
    const rootSentinel = path.join(rootDependencies, "sentinel.txt");
    const nestedSentinel = path.join(nestedDependencies, "sentinel.txt");
    const hostLoopbackServer = createServer();

    try {
      await assertExternalServerReachable("1.1.1.1", 80);
      await new Promise<void>((resolve, reject) => {
        hostLoopbackServer.once("error", reject);
        hostLoopbackServer.listen(0, "127.0.0.1", resolve);
      });
      const hostLoopbackAddress = hostLoopbackServer.address();
      if (
        hostLoopbackAddress === null ||
        typeof hostLoopbackAddress === "string"
      ) {
        throw new Error("Host loopback test server has no TCP address.");
      }
      mkdirSync(rootDependencies, { recursive: true });
      mkdirSync(nestedDependencies, { recursive: true });
      writeFileSync(
        path.join(repositoryRoot, ".gitignore"),
        ".env\nnode_modules\n",
      );
      writeFileSync(sourceFile, "original source\n");
      writeFileSync(rootSentinel, "root dependency\n");
      writeFileSync(nestedSentinel, "nested dependency\n");
      writeFileSync(
        path.join(repositoryRoot, "package.json"),
        `${JSON.stringify({
          name: "preflight-mutation-test",
          private: true,
          scripts: {
            attack: "bun attack.ts",
            fill: "bun fill.ts",
            hang: "bun hang.ts",
          },
        })}\n`,
      );
      writeFileSync(
        path.join(repositoryRoot, "attack.ts"),
        `import { writeFileSync } from "node:fs";\n` +
          `import { createConnection, createServer } from "node:net";\n` +
          `import path from "node:path";\n` +
          `writeFileSync(".env", "disposable only\\n");\n` +
          `for (const target of ${JSON.stringify([
            sourceFile,
            rootSentinel,
            nestedSentinel,
          ])}) {\n` +
          `  try { writeFileSync(target, "poisoned\\n"); } catch {}\n` +
          `}\n` +
          `const hostLoopbackConnected = await new Promise<boolean>((resolve) => {\n` +
          `  let settled = false;\n` +
          `  const socket = createConnection({ host: "127.0.0.1", port: ${hostLoopbackAddress.port} });\n` +
          `  const finish = (connected: boolean) => {\n` +
          `    if (settled) return;\n` +
          `    settled = true;\n` +
          `    socket.destroy();\n` +
          `    resolve(connected);\n` +
          `  };\n` +
          `  socket.once("connect", () => finish(true));\n` +
          `  socket.once("error", () => finish(false));\n` +
          `  socket.setTimeout(1_000, () => finish(false));\n` +
          `});\n` +
          `if (hostLoopbackConnected) throw new Error("Host loopback was not denied");\n` +
          `const socketPath = path.join(process.env.TMPDIR ?? ".", "provider.sock");\n` +
          `const unixServer = createServer((socket) => socket.end("unix"));\n` +
          `await new Promise<void>((resolve, reject) => {\n` +
          `  unixServer.once("error", reject);\n` +
          `  unixServer.listen(socketPath, resolve);\n` +
          `});\n` +
          `const unixReply = await new Promise<string>((resolve, reject) => {\n` +
          `  let reply = "";\n` +
          `  const socket = createConnection(socketPath);\n` +
          `  socket.on("data", (chunk) => { reply += chunk; });\n` +
          `  socket.once("end", () => resolve(reply));\n` +
          `  socket.once("error", reject);\n` +
          `});\n` +
          `unixServer.close();\n` +
          `if (unixReply !== "unix") throw new Error("Unix socket failed");\n` +
          `const externalConnected = await new Promise<boolean>((resolve) => {\n` +
          `  let settled = false;\n` +
          `  const socket = createConnection({ host: "1.1.1.1", port: 80 });\n` +
          `  const finish = (connected: boolean) => {\n` +
          `    if (settled) return;\n` +
          `    settled = true;\n` +
          `    socket.destroy();\n` +
          `    resolve(connected);\n` +
          `  };\n` +
          `  socket.once("connect", () => finish(true));\n` +
          `  socket.once("error", () => finish(false));\n` +
          `  socket.setTimeout(1_000, () => finish(false));\n` +
          `});\n` +
          `if (externalConnected) throw new Error("External network was not denied");\n`,
      );
      writeFileSync(
        path.join(repositoryRoot, "hang.ts"),
        `process.on("SIGTERM", () => {});\n` +
          `setInterval(() => {}, 1_000);\n`,
      );
      writeFileSync(
        path.join(repositoryRoot, "fill.ts"),
        `import { writeFileSync } from "node:fs";\n` +
          `for (let index = 0; index < 64; index += 1) {\n` +
          `  writeFileSync(\`chunk-\${index}.bin\`, Buffer.alloc(16 * 1024));\n` +
          `}\n`,
      );

      commitFixture(repositoryRoot);

      expect(runPreflight(repositoryRoot, "attack")).toBe(0);
      expect(existsSync(ignoredFile)).toBe(false);
      expect(readFileSync(sourceFile, "utf8")).toBe("original source\n");
      expect(readFileSync(rootSentinel, "utf8")).toBe("root dependency\n");
      expect(readFileSync(nestedSentinel, "utf8")).toBe("nested dependency\n");
      expect(() =>
        runPreflight(repositoryRoot, "hang", [], process.env, {
          maxWritableBytes: 64 * 1024 * 1024,
          timeoutMilliseconds: 500,
        }),
      ).toThrow("500-millisecond timeout");
      expect(() =>
        runPreflight(repositoryRoot, "fill", [], process.env, {
          maxWritableBytes: 256 * 1024,
          timeoutMilliseconds: 5_000,
        }),
      ).toThrow("writable storage limit");
    } finally {
      if (hostLoopbackServer.listening) hostLoopbackServer.close();
      rmSync(repositoryRoot, { force: true, recursive: true });
    }
  },
  20_000,
);

test("preflight mounts workspace links to the snapshot copy", () => {
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), "agent-tool-preflight-mount-"),
  );
  const repositoryRoot = path.join(temporaryRoot, "repo");
  const checkoutRoot = path.join(temporaryRoot, "checkout");
  try {
    const { library, scope, store } = createWorkspaceFixture(repositoryRoot);
    // A workspace link whose package is absent from the snapshot stays put.
    mkdirSync(path.join(repositoryRoot, "packages", "gone"), {
      recursive: true,
    });
    symlinkSync("../../../../packages/gone", path.join(scope, "gone"));
    const snapshotLibrary = path.join(checkoutRoot, "packages", "lib");
    mkdirSync(snapshotLibrary, { recursive: true });
    writeFileSync(path.join(snapshotLibrary, "index.ts"), "snapshot\n");

    const readonlyPaths = mountPreflightDependencies(
      repositoryRoot,
      checkoutRoot,
    );
    const mountedScope = path.join(
      checkoutRoot,
      "packages",
      "web",
      "node_modules",
      "@scope",
    );

    expect(realpathSync(path.join(mountedScope, "lib"))).toBe(
      realpathSync(snapshotLibrary),
    );
    expect(realpathSync(path.join(mountedScope, "dep"))).toBe(
      realpathSync(store),
    );
    expect(realpathSync(path.join(mountedScope, "gone"))).toBe(
      realpathSync(path.join(repositoryRoot, "packages", "gone")),
    );
    expect(readonlyPaths).toContain(
      realpathSync(
        path.join(repositoryRoot, "packages", "web", "node_modules"),
      ),
    );
    expect(readonlyPaths).toContain(
      realpathSync(path.join(repositoryRoot, "node_modules")),
    );
    expect(readonlyPaths).not.toContain(realpathSync(library));
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test.skipIf(
  process.platform !== "darwin" ||
    Reflect.get(process.env, "TEARLEADS_PREFLIGHT_OFFLINE") === "1",
)(
  "preflight resolves workspace packages without exposing their source",
  () => {
    const repositoryRoot = mkdtempSync(
      path.join(tmpdir(), "agent-tool-preflight-workspace-"),
    );
    try {
      const { library } = createWorkspaceFixture(repositoryRoot);
      writeFileSync(path.join(repositoryRoot, ".gitignore"), "node_modules\n");
      writeFileSync(
        path.join(repositoryRoot, "package.json"),
        `${JSON.stringify({
          name: "preflight-workspace-test",
          private: true,
          scripts: { imports: "bun packages/web/imports.ts" },
        })}\n`,
      );
      writeFileSync(
        path.join(repositoryRoot, "packages", "web", "imports.ts"),
        `import { writeFileSync } from "node:fs";\n` +
          `import { dependency } from "@scope/dep";\n` +
          `import { library } from "@scope/lib";\n` +
          `if (library !== "workspace library") throw new Error(library);\n` +
          `if (dependency !== "installed dependency") throw new Error(dependency);\n` +
          `try { writeFileSync(${JSON.stringify(path.join(library, "index.ts"))}, "poisoned\\n"); } catch {}\n`,
      );
      commitFixture(repositoryRoot);

      expect(runPreflight(repositoryRoot, "imports")).toBe(0);
      expect(readFileSync(path.join(library, "index.ts"), "utf8")).toBe(
        'export const library = "workspace library";\n',
      );
    } finally {
      rmSync(repositoryRoot, { force: true, recursive: true });
    }
  },
  20_000,
);
