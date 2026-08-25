import { expect, test } from "bun:test";
import type { TrustedExecutable } from "../review/trustedExecutable";
import {
  buildPreflightEnvironment,
  buildPreflightSandboxProfile,
} from "./runPreflight";

const runtime: TrustedExecutable = {
  executable: "/trusted/bun/bin/bun",
  readablePaths: ["/trusted/bun/bin", "/trusted/bun/bin/bun"],
};

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
    "/Users/example/repo",
    "/private/tmp/preflight-home",
    [runtime],
  );

  expect(profile).toContain("(deny network*)");
  expect(profile).toContain("(allow signal (target children))");
  expect(profile).toContain(
    '(allow network-bind network-outbound (subpath "/private/tmp/preflight-home"))',
  );
  expect(profile).toContain('(allow network-bind (local ip "*:*"))');
  expect(profile).toContain("(allow network-inbound (local ip))");
  expect(profile).toContain('(allow network-bind (local ip "localhost:*"))');
  expect(profile).toContain(
    '(allow network-outbound (remote ip "localhost:*"))',
  );
  expect(profile).toContain("(allow file-read-metadata)");
  expect(profile).toContain(
    '(deny file-write* (subpath "/Users/example/repo/.git") (subpath "/Users/example/repo/node_modules"))',
  );
  expect(profile).toContain('(subpath "/Users/example/repo")');
  expect(profile).toContain('(subpath "/private/tmp/preflight-home")');
  expect(profile).not.toContain('(subpath "/Users/example")');
});
