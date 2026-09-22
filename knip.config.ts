import type { KnipConfig } from "knip";

const rootToolingWorkspace = {
  entry: ["commitlint.config.mts"],
  project: ["*.{ts,mts}"],
  ignoreDependencies: ["markdownlint-cli2"],
  ignoreBinaries: ["shellcheck"],
};

// Knip does not read CSS by default; surfacing @import lets it see font
// packages and stylesheet partials as used.
const compilers = {
  css: (text: string) =>
    [...text.matchAll(/@import\s+(?:url\()?["']([^"']+)["']/g)]
      .map(([, specifier]) => `import "${specifier}";`)
      .join("\n"),
};

const baseConfig = {
  compilers,
  treatConfigHintsAsErrors: true,
  workspaces: {
    ".": rootToolingWorkspace,
    "apps/api": {
      entry: ["src/**/*.test.ts"],
      project: ["src/**/*.ts"],
    },
    "apps/client": {
      entry: [],
      project: ["src/**/*.{css,ts,tsx}"],
    },
    "apps/website": {
      entry: ["src/pages/**/*.astro"],
      project: ["src/**/*.{astro,ts}"],
    },
    "packages/agent-tool": {
      entry: ["src/index.ts", "src/**/*.test.ts"],
      project: ["src/**/*.ts"],
    },
    "packages/ui": {
      entry: ["src/**/*.test.ts"],
      project: ["src/**/*.{css,ts,tsx}"],
    },
  },
} satisfies KnipConfig;

const productionConfig = {
  compilers,
  treatConfigHintsAsErrors: true,
  workspaces: {
    ".": rootToolingWorkspace,
    "apps/api": {
      entry: ["src/**/*.ts!", "!src/**/*.test.ts"],
      project: [],
    },
    "apps/client": {
      entry: ["src/**/*.{ts,tsx}!"],
      project: [],
    },
    "apps/website": {
      entry: ["astro.config.ts!", "src/**/*.{astro,ts}!"],
      project: [],
    },
    "packages/agent-tool": {
      entry: ["src/index.ts!"],
      project: [],
    },
    // Production mode does not follow CSS @import chains, so the partials
    // that import the font packages are listed as entries themselves.
    "packages/ui": {
      entry: ["src/styles/*.css!"],
      project: [],
    },
  },
} satisfies KnipConfig;

export default ((options) =>
  options.production ? productionConfig : baseConfig) satisfies KnipConfig;
