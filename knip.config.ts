import type { KnipConfig } from "knip";

const rootToolingWorkspace = {
  entry: ["commitlint.config.mts"],
  project: ["*.{ts,mts}"],
  ignoreDependencies: ["markdownlint-cli2"],
  ignoreBinaries: ["shellcheck"],
};

const baseConfig = {
  treatConfigHintsAsErrors: true,
  workspaces: {
    ".": rootToolingWorkspace,
    "apps/api": {
      entry: ["src/**/*.test.ts"],
      project: ["src/**/*.ts"],
    },
    "apps/client": {
      entry: [],
      project: ["src/**/*.{ts,tsx}"],
    },
    "apps/website": {
      entry: ["src/pages/**/*.astro"],
      project: ["src/**/*.{astro,ts}"],
    },
  },
} satisfies KnipConfig;

const productionConfig = {
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
  },
} satisfies KnipConfig;

export default ((options) =>
  options.production ? productionConfig : baseConfig) satisfies KnipConfig;
