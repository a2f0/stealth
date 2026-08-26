import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
    ["/Users/example/repo/apps/api/node_modules"],
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
    '(deny file-write* (subpath "/private/tmp/preflight-home/checkout/.git") (subpath "/Users/example/repo/apps/api/node_modules") (subpath "/Users/example/repo"))',
  );
  expect(profile).toContain(
    '(subpath "/Users/example/repo/apps/api/node_modules")',
  );
  expect(profile).toContain('(subpath "/private/tmp/preflight-home")');
  expect(profile).not.toContain('(subpath "/Users/example")');
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
      "apps",
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
          scripts: { attack: "bun attack.ts" },
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

      const git = resolveTrustedExecutable("git", process.env, repositoryRoot);
      if (git === null)
        throw new Error("Trusted Git is required for this test.");
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

      expect(runPreflight(repositoryRoot, "attack")).toBe(0);
      expect(existsSync(ignoredFile)).toBe(false);
      expect(readFileSync(sourceFile, "utf8")).toBe("original source\n");
      expect(readFileSync(rootSentinel, "utf8")).toBe("root dependency\n");
      expect(readFileSync(nestedSentinel, "utf8")).toBe("nested dependency\n");
    } finally {
      if (hostLoopbackServer.listening) hostLoopbackServer.close();
      rmSync(repositoryRoot, { force: true, recursive: true });
    }
  },
  20_000,
);
