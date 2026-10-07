---
name: update-dependencies
description: Update dependencies with the shared upgrade safety workflow while preserving Stealth's trusted-base shipping policy.
---

# Update dependencies

Read README.md and docs/dependency-upgrades.md before changing dependencies.
Apply the [shared upgrade skill at agent-tool 0.1.10][shared-skill]. Its immutable
source commit is `1ddee340e4d6e9a62fed9e02580610439f9e88b1`.

When this checkout is in Matrix, the published skill is also available at
`../../node_modules/@a2f0/agent-tool/skills/update-dependencies/SKILL.md` from the
repository root. Read the adjacent package.json and require version `0.1.10`
before using that copy. Outside Matrix, read the immutable source link above,
or the same `skills/update-dependencies/SKILL.md` in an installed copy of the
exact public package `@a2f0/agent-tool@0.1.10`.

Always preview before infrastructure apply or deployment. Never destroy,
replace, or recreate resources. Terraform upgrades need complete refreshed
plans from both real stacks; Wrangler bundling alone does not prove remote
resource safety. Hold a compatibility group when its safety or platform
validation is unavailable, and record the limitation.

Use the public package only for its read-only dependency helper:

```sh
bunx --package @a2f0/agent-tool@0.1.10 agent-tool \
  dependencies check-terraform-plan /private/path/complete-plan.json
```

Inside Matrix, after verifying the installed package version, the equivalent
qualified command avoids confusing it with this repository's legacy CLI:

```sh
bun --no-env-file --config=/dev/null \
  ../../node_modules/@a2f0/agent-tool/src/index.ts \
  dependencies check-terraform-plan /private/path/complete-plan.json
```

For authorized shipping, invoke this repository's `ship-pr` and
`cross-agent-review` skills. They materialize `packages/agent-tool` from the
freshly fetched trusted base. Preserve their credential-free preflight, signed
commits, package version bumps, independent review, strict CI, and exact
reviewed head/base gates. Installing the public skill bundle here would collide
with these repository-owned shipping skills; retain the existing workflow.

[shared-skill]: https://github.com/a2f0/agent-tool/blob/1ddee340e4d6e9a62fed9e02580610439f9e88b1/skills/update-dependencies/SKILL.md
