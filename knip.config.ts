import type { KnipConfig } from "knip";

const rootToolingWorkspace = {
  project: ["*.{css,ts,mts}"],
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
    "packages/agent-tool": {
      entry: ["src/index.ts", "src/**/*.test.ts"],
      project: ["src/**/*.{css,ts}"],
    },
    "packages/api": {
      entry: ["src/**/*.test.ts"],
      project: ["src/**/*.{css,ts}"],
    },
    "packages/client": {
      entry: ["browser/**/*.test.tsx"],
      project: ["src/**/*.{css,ts,tsx}", "browser/**/*.tsx"],
    },
    "packages/ui": {
      entry: ["src/**/*.test.ts"],
      project: ["src/**/*.{css,ts,tsx}"],
    },
    "packages/website": {
      entry: ["src/pages/**/*.astro"],
      project: ["src/**/*.{astro,css,ts}"],
    },
  },
} satisfies KnipConfig;

const productionConfig = {
  compilers,
  treatConfigHintsAsErrors: true,
  workspaces: {
    ".": rootToolingWorkspace,
    "packages/agent-tool": {
      entry: ["src/index.ts!"],
      project: [],
    },
    "packages/api": {
      entry: ["src/**/*.ts!", "!src/**/*.test.ts"],
      project: [],
    },
    "packages/client": {
      entry: ["src/**/*.{ts,tsx}!"],
      project: [],
    },
    // Production mode does not follow CSS @import chains, so the partials
    // that import the font packages are listed as entries themselves.
    "packages/ui": {
      entry: ["src/styles/*.css!"],
      project: [],
    },
    "packages/website": {
      entry: ["astro.config.ts!", "src/**/*.{astro,ts}!"],
      project: [],
    },
  },
} satisfies KnipConfig;

export default ((options) =>
  options.production ? productionConfig : baseConfig) satisfies KnipConfig;
