# Dependency upgrades

Bun 1.4.2 owns `bun.lock`. Node.js must be at least 22.22.1 for lint-staged;
CI installs Node.js 24.21.0. Preserve exact direct dependency pins and keep
React, React DOM, their types, and the UI peer versions aligned.

Use the `update-dependencies` skill for either harness. It references the
published shared workflow at `@a2f0/agent-tool@0.1.10` while keeping this
repository's trusted-base `packages/agent-tool` shipping implementation.

## Compatibility

- TypeScript stays on 6.0.3 because `@astrojs/check` supports TypeScript 5/6.
  The native TypeScript 7 release removes APIs used by language tooling.
  Explicit Bun types in the automation workspace account for TypeScript 6's
  new default type inclusion. See the [TypeScript 6 release notes][typescript].
- The [Astro 7 guide][astro] covers the Rust compiler, Markdown processor,
  whitespace defaults, and removed APIs. This website already used Astro 7;
  7.3.6 includes fixes for the [AVIF image advisory][astro-advisory].
- [Commitlint 21][commitlint] raises its Node requirement and changes diagnostic
  formatting. Its header policy still requires Conventional Commits and a
  maximum of 50 characters; this repository does not parse its diagnostics.
- [Lint-staged 17][lint-staged] requires Node 22.22.1 and Git 2.32.0. Configuration
  is in package.json, so the optional YAML configuration dependency is not
  needed to load the staged-file rules.
- [Knip 6.40][knip] reports exports used only in their declaring file. Keep
  those declarations private, preserve both full and production analysis,
  and include CSS in project patterns for the font import compiler.

## Security fixes and remaining constraints

Markdownlint CLI 0.23.3 pins smol-toml 1.8.0, which is affected by
[GHSA-r4xh-jqrq-34v2][toml-advisory]. An exact-parent override selects the fixed
1.9.0 parser. Its null-prototype objects expose a Markdownlint 0.41.1
`instanceof Object` incompatibility: nested TOML rule options, disabled rules,
and warning severity are silently lost. A Bun-generated patch recognizes
null-prototype objects; `bun run test:markdownlint` exercises the actual CLI
with TOML, JSON, and the repository JSONC configuration. Remove the override
when the CLI permits the fixed parser; remove the patch when Markdownlint
preserves the same six regression cases without it.

Wrangler and the API's prerelease Miniflare are retained when real resource
previews or the Workerd integration are unavailable. Their exact Sharp and
Undici pins can retain security advisories; a blanket override would bypass
the owner's supported integration. Braces 3.0.3 is still brought in by
Markdownlint's Micromatch dependency and has no published fixed release for
[GHSA-vfj7-8cjw-p6xm][braces-advisory]. KaTeX 0.16.47 also remains inside
Micromark's math extension's supported range;
its advisory requires 0.18.2, outside that range. Retain it until an owner
upgrade or a tested, narrowly scoped compatibility patch is available.

HTTP Cache Semantics 4.3.0 satisfies Astro's range, but its [shared cache
advisory][cache-advisory] has no maintainer-confirmed patched version. Astro's
cache immediately expires the affected zero-TTL entries and does not pass
`max-stale`; a package version outside the advisory's published range alone
does not prove the library flaw fixed. Review the full final audit and exposure
before claiming the dependency graph is safe.

## Infrastructure and deployment

Run complete refreshed saved Terraform plans against the real production and
staging states, with their own variables and resource identities, before
changing Terraform core, providers, or modules. Reject every deletion,
replacement, recreation, incomplete plan, or unknown action. The historical
email-rule retirement described in terraform/README.md includes destruction;
it must not be executed as part of a dependency upgrade.

Wrangler's `deploy --dry-run` bundles code. Independently verify the deployed
account, Worker, domains/routes, D1 and R2 IDs, bindings, and migration effects.
When remote identity or data effects cannot be established, retain Wrangler
and its coupled deployment changes. Do not run an apply or deployment to
establish compatibility. The branch CI only checks, tests, and builds.

## Validation and shipping

Install dependencies and hooks as described in README.md. Run the complete
`check`, `test`, client browser tests, and `build` commands. The Workerd upload
integration requires local sockets; provider validation and TFLint require
the installed provider/plugin runtime. An unavailable platform or service is
a validation gap, even when unrelated checks pass.

Use the repository-owned `ship-pr` skill with `chore: update dependencies`.
It fetches and materializes the trusted base automation, runs its
credential-free preflight, signs commits, bumps changed API/client packages,
independently reviews each changed HEAD, and checks CI and the exact fresh
reviewed head/base before merging. Preserve every gate when resuming a held
upgrade. Keep a ledger of selected and constrained dependencies, audits,
checks, warnings, previews, review, PR, merge, and deployment results.

[typescript]: https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html
[astro]: https://docs.astro.build/en/guides/upgrade-to/v7/
[astro-advisory]: https://github.com/withastro/astro/security/advisories/GHSA-26w7-cxv4-gfx2
[commitlint]: https://github.com/conventional-changelog/commitlint/releases/tag/v21.0.0
[lint-staged]: https://github.com/lint-staged/lint-staged/releases/tag/v17.0.0
[knip]: https://github.com/webpro-nl/knip/releases/tag/knip%406.40.0

[toml-advisory]: https://github.com/advisories/GHSA-r4xh-jqrq-34v2
[braces-advisory]: https://github.com/advisories/GHSA-vfj7-8cjw-p6xm

[cache-advisory]: https://github.com/advisories/GHSA-ch52-4w7c-c8xp
