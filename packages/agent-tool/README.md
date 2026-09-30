# @tearleads/agent-tool

Minimal CLI for cross-agent code review, reviewed PR merges, and the version
bumps that ship with them.

## Cross-agent review

Solicits a review of the current branch's diff from a local coding-agent CLI
(`claude` or `codex`), so one agent can request a second opinion from another. The
branch need not have a PR yet — with none open, the diff is taken against the
default branch.

Use the `cross-agent-review` skill. It materializes this package from the
fetched base commit before invoking `solicitClaudeCodeReview` or
`solicitCodexReview`, optionally with an explicit effort and pinned base SHA.
Do not execute the copy in an untrusted feature checkout: the launcher runs
before the reviewer sandbox and receives reviewer credentials.

Both actions accept an optional second argument containing an expected base SHA
and re-fetch that exact base after the reviewer exits successfully. This lets a
wrapper prove that the reviewed and reported base are identical. Both actions:

1. Resolve the review base from git + `gh` — the PR's base when the branch has an
   open PR, the repository's default branch when it does not — and snapshot the
   exact local head, requiring it to match an open PR's pushed head.
2. Load `REVIEW.md` or `AGENTS.md` from that trusted base commit, never from the
   contributor-controlled feature worktree, and verify there are changes.
3. Build the verdict-gated prompt and tracked-only checkout from that exact
   base/head pair, then hand the prompt to the target agent's CLI on stdin.
4. Relay the review to stdout and gate it: a usable review carries a
   `VERDICT: BLOCKER|MAJOR|MINOR|SUGGESTION|CLEAN` line. An exit-0 run without
   one is retried once (the observed failure mode is stochastic), then reported
   as a nonzero exit. Afterward, re-resolve both local and pushed heads and
   reject the result if either changed while the reviewer was running.

Claude reviews in bare safe mode, with project hooks, plugins, settings, MCP,
keychain access, and persistence disabled and only read-only tools
(`Read,Grep,Glob`, no `Bash`). It runs inside a standalone Codex filesystem
sandbox and authenticates only from an allowlisted API-key environment. Codex
reviews via `codex exec` with the user config ignored and a least-privilege
filesystem profile. Both reviewers get a temporary snapshot containing only
committed tracked files; ignored files, untracked secrets, and neighboring
repositories are unreadable. Codex shell environment inheritance is disabled,
and each reviewer process receives only an auth/transport allowlist. Before any
credentials are exposed, the launcher resolves Codex and Claude to absolute
executables outside the repository and replaces `PATH` with trusted runtime and
system directories, so a contributor-controlled shadow binary cannot run. The
temporary directory is the primary workspace, so contributor-controlled
`AGENTS.md` files inside the nested checkout are data rather than reviewer
policy. Only the final message — captured with `--output-last-message` — is
relayed, so the output is the review itself rather than the investigative
transcript.

The optional effort argument sets the reviewer's reasoning effort, defaulting to
**`xhigh` for Claude** and **`high` for Codex**. It is passed as
`claude --effort <level>` and `codex exec -c model_reasoning_effort="<level>"`,
always explicitly — so a Codex review never silently inherits
`~/.codex/config.toml`. An unknown level throws before the reviewer CLI is
launched.

The exit code is the reviewing CLI's exit code (or `1` for a review that failed
the verdict gate), so callers can fall back to another reviewer on failure.
Backs the `cross-agent-review` skill in `.claude/skills/` and `.codex/skills/`.
Full-diff prompt capture is capped at 8 MiB before a reviewer starts; an
oversized diff exits nonzero so the skill switches to its streaming,
path-by-path in-session review rather than retaining an unbounded prompt.

These actions **only review**. The fallback chain, the severity gate, and the
bounded repair loop live in the `cross-agent-review` skill *around* these calls
— invoking the actions directly gets you one raw review and no repair.

## Credential-free preflight

`runPreflight` snapshots tracked and non-ignored working files into a disposable
checkout, strips credentials, blocks TCP and host configuration reads with
macOS Seatbelt, and exposes only resolved versioned runtime/library paths plus
read-only dependency trees. Each run is limited to ten minutes, 512 MiB of
writable storage, and 128 MiB per file. The supervisor terminates the complete
child process group on timeout or storage exhaustion before removing the
temporary checkout.

## Open a PR

Opens a pull request for the current branch with a **commitlint-conforming
title**.

Use the `open-pr` skill, which invokes `openPr` from a trusted base snapshot and
accepts an explicit title and body or defaults the title to the latest commit
subject.

The title is validated with the trusted tool snapshot's side-effect-free copy
of the repository's commitlint header policy, so conventional-commit syntax and
the 50-char header limit apply without executing feature-checkout
configuration. The body is read from stdin (empty when none is piped), the head
is the current branch's resolved GitHub push repository, and the base defaults
to the repository's default branch. PR lookup matches both the branch name and
push repository, so a same-named branch from another fork is never selected.
Errors if a matching open PR already exists. Backs the `open-pr` skill.

## Reviewed merge

Squash-merges the current PR with a **subject-only** commit message — no
auto-generated body or extended message.

Use the `squash-merge` skill, which invokes `squashMerge` from a trusted base
snapshot and can bind the merge to an exact reviewed head/base pair.

The subject is validated against the trusted tool snapshot's side-effect-free
copy of the repository's commitlint header policy, so conventional-commit
syntax and the 50-char header limit are enforced without executing
feature-checkout configuration. The two review SHAs must be supplied together.
With both present, the tool fetches and ancestry-checks the reviewed base,
refreshes the PR, and inspects GitHub's effective branch policy. It requires
strict up-to-date status checks so GitHub can atomically guard the reviewed base;
unprotected branches and weaker policies are rejected with setup guidance. A
qualifying protected branch merges immediately through GitHub's
policy-enforcing API only when every requirement is already clean.
The guarded path never enables delayed auto-merge, because a later writer push
could escape the reviewed head lease. Merge queues are rejected because their
generated merge-group commit and configured merge method are not the reviewed
head/base pair; weaker policy is also rejected with setup guidance. The
unguarded form remains GitHub's ordinary squash API for manual use. Backs the
`squash-merge` compatibility skill.

For the unguarded compatibility form, if GitHub queues the merge, the command
polls for up to ten minutes for the PR to reach the terminal `MERGED` or
`CLOSED` state. After that it exits `2`, says that the auto-merge or queue entry
may still be active, and requires the caller to skip cleanup until GitHub
separately confirms `MERGED`.

The tool only merges. Returning to the base branch, fast-forwarding it, and
deleting the merged branch live in the `squash-merge` skill *around* this call —
as does its `--keep-branch` flag, which the tool does not accept. Invoking the
tool directly merges without any of that cleanup.

## Version bumps

Keeps each versioned package — `packages/api` (the backend) and
`packages/client` (the frontend) — one patch past its version on the base the
branch merges onto.

```bash
# Rewrite the package.json versions that are off; prints the rewritten paths:
bun packages/agent-tool/src/index.ts bumpVersions "$BASE_OID"
# Exit non-zero when a versioned package at HEAD is not at its target:
bun packages/agent-tool/src/index.ts checkVersions "$BASE_OID"
# Mid-merge: finish a base merge whose only conflicts are those version fields:
bun packages/agent-tool/src/index.ts resolveVersionConflicts
```

The target for each package is computed from committed `HEAD` and the full base
OID: one patch past the base's version when the branch changes anything in the
package (its `package.json` counts only for edits beyond `version`), the base's
own version when it changes nothing, and the branch's version when that is a
deliberate major or minor bump. Only the `version` line is rewritten, and
`bumpVersions` refuses a manifest with uncommitted edits or one that is not a
regular file. It never commits; the caller commits the printed paths. `bun.lock`
is left alone: Bun neither rewrites nor rejects its stale workspace versions,
even under `--frozen-lockfile`.

`resolveVersionConflicts` re-runs the three-way merge of each conflicted
manifest with every side's version set to one value: the branch's when it is a
deliberate major or minor release over the incoming base, the base's otherwise.
It stages the result only when that merges cleanly and every conflicted path is
a versioned manifest; otherwise it changes nothing and exits non-zero. The
following `bumpVersions` then moves the version one past the base.

Every Git call runs with repository hooks disabled, because an index write
(`git add`, even `git status`) would otherwise run `post-index-change` with the
caller's credentials.

`cross-agent-review --bump-versions` runs these after each base sync, and
`ship-pr` always passes that flag and gates its merge on `checkVersions`. Both
take the actions from the trusted base snapshot; when that snapshot predates
them, `TEARLEADS_AGENT_TOOL_DIR` may name a trusted installation that has them,
and without one only a branch that leaves both versioned packages exactly as
the base has them can ship.

## Ship (commit → review → repair → open/resume → merge → reset)

The `ship-pr` skill commits the work on a feature branch, hands it to
`cross-agent-review` — which syncs the base, patch-bumps the changed versioned
packages, reviews the local commits (or the pushed head when a PR is already
open), repairs blocking findings until none remain, and re-reviews every head
it changes — then opens or resumes the PR with a single push. Before merging,
it fetches the base branch's tip and sends a branch that has fallen behind back
through that sync, bump, and review. It merges through GitHub only after
re-verifying the reviewed head and base that review reports back.
Opening the PR after the review is what keeps the branch to a single push
through the pre-push hook. It finishes by handing off to `reset`, which returns
the checkout to the default branch and reinstalls the repo's git hooks, so a
merged change under `scripts/git/hooks/` takes effect instead of sitting
uninstalled. It adds no new CLI action; it orchestrates the `open-pr`,
`cross-agent-review`, `squash-merge`, and `reset` skills. See
`.claude/skills/ship-pr/` and `.codex/skills/ship-pr/`.

Review and repair are one unit, owned by `cross-agent-review`; `ship-pr` keeps
only the merge gate (and `--merge-anyway` to override it). For a review that
changes nothing, invoke `cross-agent-review` with `--report-only`.

## Prerequisites

- `git` and `gh` (authenticated) on `PATH`.
- `claude` CLI with `ANTHROPIC_API_KEY` available for its bare sandboxed review.
- `codex` CLI configured (`OPENAI_API_KEY`) for `solicitCodexReview`.
- A PR on the current branch: `squashMerge` requires an open one; `openPr`
  requires that none exists; the review actions work with or without one (with
  none, they review against the default branch).
