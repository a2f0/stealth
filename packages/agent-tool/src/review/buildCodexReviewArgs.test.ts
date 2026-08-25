import { describe, expect, test } from "bun:test";

import {
  buildCodexReviewArgs,
  reviewerEnvironment,
} from "./solicitCodexReview";

describe("buildCodexReviewArgs", () => {
  test("execs with least privilege and pinned effort, capturing the last message", () => {
    const args = buildCodexReviewArgs("high", "/tmp/x/review-1.md", "/tmp/x");

    expect(args).toEqual([
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "--strict-config",
      "--disable",
      "plugins",
      "--disable",
      "hooks",
      "--disable",
      "apps",
      "--cd",
      "/tmp/x",
      "--skip-git-repo-check",
      "-c",
      'model_reasoning_effort="high"',
      "-c",
      'default_permissions="agent-tool-review"',
      "-c",
      'permissions.agent-tool-review.filesystem={":minimal"="read",":workspace_roots"={"."="read"}}',
      "-c",
      'shell_environment_policy.inherit="none"',
      "-c",
      "shell_environment_policy.experimental_use_profile=false",
      "-c",
      'shell_environment_policy.set={PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin"}',
      "--color",
      "never",
      "--output-last-message",
      "/tmp/x/review-1.md",
      "-",
    ]);
  });

  test("withholds MCP tools: the sandbox does not confine them", () => {
    // A filesystem profile restricts shell commands; user-configured MCP
    // servers would still load and could mutate external state on behalf of an
    // attacker-influenceable diff. `-c mcp_servers={}` cannot remove them —
    // table overrides merge — so the user config is ignored wholesale, and
    // plugins, hooks, and app connectors (all merged from outside config.toml)
    // are disabled by feature flag.
    const args = buildCodexReviewArgs("high", "/tmp/x/review-1.md", "/tmp/x");

    expect(args).toContain("--ignore-user-config");
    const disabled = args.filter(
      (_, i) => i > 0 && args[i - 1] === "--disable",
    );
    expect(disabled).toEqual(["plugins", "hooks", "apps"]);
  });

  test("reads the prompt from stdin, never argv", () => {
    const args = buildCodexReviewArgs("xhigh", "/tmp/x/review-1.md", "/tmp/x");

    // `-` must be the trailing positional: it is what makes codex read the
    // prompt (and its potentially argv-breaking diff) from stdin.
    expect(args.at(-1)).toBe("-");
    expect(args).toContain('model_reasoning_effort="xhigh"');
  });

  test("does not load contributor instructions as workspace policy", () => {
    const args = buildCodexReviewArgs("high", "/tmp/x/review.md", "/tmp/x");
    expect(args.slice(args.indexOf("--cd"), args.indexOf("--cd") + 2)).toEqual([
      "--cd",
      "/tmp/x",
    ]);
    expect(args).not.toContain("/repo");
    expect(args).toContain('default_permissions="agent-tool-review"');
  });

  test("does not expose application secrets to the reviewer process", () => {
    expect(
      reviewerEnvironment({
        PATH: "/bin",
        HOME: "/home/reviewer",
        OPENAI_API_KEY: "review-auth",
        DATABASE_URL: "secret-db",
        CLOUDFLARE_API_TOKEN: "secret-cloudflare",
      }),
    ).toEqual({
      PATH: "/bin",
      HOME: "/home/reviewer",
      OPENAI_API_KEY: "review-auth",
    });
  });
});
