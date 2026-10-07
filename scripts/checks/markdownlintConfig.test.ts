import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(
  new URL(
    "../../node_modules/markdownlint-cli2/markdownlint-cli2-bin.mjs",
    import.meta.url,
  ),
);
const fixtures: string[] = [];

afterEach(() => {
  for (const directory of fixtures.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(config: string, markdown = "# Good\n") {
  const directory = mkdtempSync(join(tmpdir(), "stealth-markdownlint-"));
  fixtures.push(directory);
  mkdirSync(join(directory, "docs"));
  writeFileSync(join(directory, "docs/good.md"), markdown);
  writeFileSync(join(directory, "pyproject.toml"), config);
  return directory;
}

function lint(
  directory: string,
  glob = "docs/*.md",
  config = "pyproject.toml",
) {
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "--config",
      config,
      "--configPointer",
      "/tool/markdownlint-cli2",
      glob,
    ],
    { cwd: directory, encoding: "utf8", timeout: 20_000 },
  );
  if (result.error) throw result.error;
  return { status: result.status, output: result.stdout + result.stderr };
}

test("nested TOML rule options enforce prose limits and exempt headings", () => {
  const directory = fixture(
    `[tool.markdownlint-cli2.config]
default = false
[tool.markdownlint-cli2.config.MD013]
line_length = 12
headings = false
code_blocks = false
`,
    "# Heading is exempt\n\nThis paragraph exceeds twelve columns.\n",
  );
  const result = lint(directory);
  expect(result.status).toBe(1);
  expect(result.output).toContain("MD013/line-length");
  expect(result.output).toContain("good.md:3");
  expect(result.output).not.toContain("good.md:1");
});

test("nested TOML enabled=false keeps a rule disabled", () => {
  const directory = fixture(
    `[tool.markdownlint-cli2.config]
default = false
[tool.markdownlint-cli2.config.MD018]
enabled = false
`,
    "#Missing space\n",
  );
  expect(lint(directory).status).toBe(0);
});

test("nested TOML severity preserves ordinary JSON behavior", () => {
  const directory = fixture(
    `[tool.markdownlint-cli2.config]
default = false
[tool.markdownlint-cli2.config.MD018]
severity = "warning"
`,
    "#Missing space\n",
  );
  writeFileSync(
    join(directory, "config.json"),
    JSON.stringify({
      tool: {
        "markdownlint-cli2": {
          config: { default: false, MD018: { severity: "warning" } },
        },
      },
    }),
  );
  const toml = lint(directory);
  const ordinary = lint(directory, "docs/*.md", "config.json");
  expect(ordinary.output).toContain("MD018/no-missing-space-atx");
  expect(toml).toEqual(ordinary);
});

test("TOML ignores and default=false retain their scope", () => {
  const directory = fixture(`[tool.markdownlint-cli2]
ignores = ["docs/ignored.md"]
[tool.markdownlint-cli2.config]
default = false
MD018 = true
`);
  writeFileSync(join(directory, "docs/ignored.md"), "#Missing space\n");
  const result = lint(directory, "docs/{good,ignored}.md");
  expect(result.status).toBe(0);
  expect(result.output).toContain("Linting: 1 file");
});

test("malformed TOML remains a fatal configuration error", () => {
  const directory = fixture("[tool.markdownlint-cli2]\nignores = [\n");
  const result = lint(directory);
  expect(result.status).not.toBe(0);
  expect(result.output).toMatch(/Unable to parse|invalid|Invalid|Error/i);
});

test("the repository JSONC configuration keeps code blocks exempt", () => {
  const directory = fixture("");
  writeFileSync(
    join(directory, ".markdownlint-cli2.jsonc"),
    readFileSync(new URL("../../.markdownlint-cli2.jsonc", import.meta.url)),
  );
  writeFileSync(
    join(directory, "docs/good.md"),
    `# Good\n\n\`\`\`text\n${"Long code ".repeat(30).trim()}\n\`\`\`\n`,
  );
  const result = spawnSync(process.execPath, [cli, "docs/good.md"], {
    cwd: directory,
    encoding: "utf8",
    timeout: 20_000,
  });
  if (result.error) throw result.error;
  expect(result.status).toBe(0);
});
