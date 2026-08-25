---
name: squash-merge
description: Merge the current PR with a subject-only message through GitHub's policy gate, binding supplied review SHAs, then return to the PR's base branch, fast-forward it, and delete the merged branch
---

# Reviewed Merge (`squash-merge` compatibility)

Merge the open PR for the current branch with a **subject-only** commit
message — no auto-generated body, commit list, or extended message. The subject
is validated against the repository's own commitlint configuration before the
merge runs, and the tool appends the PR reference `(#<pr>)` so the merge
commit ends with it — the same reference GitHub adds for web/default merges but
that `gh pr merge --subject` otherwise suppresses.

Once the PR is confirmed `MERGED`, return to the PR's base branch, fast-forward
it, and delete the merged branch, so a shipped PR leaves no local leftovers.

## Arguments

- First argument (optional): the merge commit subject. When omitted, the PR
  title is used. Pass it as a single quoted argument, e.g.
  `"feat(app): add widget"`.
- Second argument (optional): the expected PR head SHA.
- Third argument (optional): the expected PR base SHA. The two SHAs must be
  supplied together. The guarded path requires the base to remain current and
  invokes GitHub with an exact expected head, so a moved pair is rejected and
  repository merge policy is enforced by the final API mutation.
- `--keep-branch` (optional flag, position-independent): skip the post-merge
  cleanup (step 4) and stay on the feature branch. Use when the branch is still
  needed locally (e.g. to build a follow-up PR on top of it).

  **This flag is consumed by this skill and must never reach the tool.** The
  tool takes only the three positionals above — subject, head SHA, base SHA —
  and how a forwarded `--keep-branch` fails depends on where it lands: first, it
  is read as the *subject* and rejected by commitlint; after the positionals
  (the position `ship-pr` forwards), it is **silently ignored**. The silent case
  is the dangerous one — the merge succeeds, the caller believes cleanup was
  skipped, and it ran anyway. Strip the flag from the arguments, let it gate
  step 4, and call the tool with the subject and SHA only.

## Prerequisites

- `git`, `gh` (authenticated), and POSIX `awk` on `PATH`.
- The `@tearleads/agent-tool` package: `packages/agent-tool/src/index.ts`.
- `node_modules` installed (`bun install`) so the commitlint CLI is available.
- An open, mergeable PR on the current branch.

## Setup

Check the branch **before** looking up the PR, so running on the default branch
reports that plainly rather than a confusing "no open PR" error. Resolve the PR
number **before** merging — afterwards the PR is no longer open, so
`gh pr list --state open` will not find it:

```bash
ROOT_DIR=$(git rev-parse --show-toplevel)
BRANCH=$(git rev-parse --abbrev-ref HEAD)
AGENT_TOOL="$ROOT_DIR/packages/agent-tool/src/index.ts"
[ -f "$AGENT_TOOL" ] || { echo "Error: agent-tool not found at $AGENT_TOOL" >&2; exit 1; }

# One gh call for both values, split on the space neither a repo slug nor a
# branch name may contain. Guard each: an unauthenticated gh leaves them empty,
# and an empty REPO turns every later lookup into a confusing error.
REPO_INFO=$(gh repo view --json nameWithOwner,defaultBranchRef -q '.nameWithOwner + " " + .defaultBranchRef.name') || { echo "Error: gh repo view failed (authenticated?)" >&2; exit 1; }
REPO=${REPO_INFO%% *}
DEFAULT_BRANCH=${REPO_INFO##* }
[ -n "$REPO" ] || { echo "Error: could not resolve repository" >&2; exit 1; }
[ -n "$DEFAULT_BRANCH" ] || { echo "Error: repository default branch is unavailable" >&2; exit 1; }
[ "$BRANCH" != "$DEFAULT_BRANCH" ] || { echo "Error: on default branch $DEFAULT_BRANCH" >&2; exit 1; }
BASE_REPO_URL=$(gh repo view "$REPO" --json url -q .url) || { echo "Error: could not resolve HTTPS URL for $REPO" >&2; exit 1; }

# Keep the feature branch's push remote separate from the base branch's pull
# remote. On a fork these are different repositories.
FEATURE_REMOTE=$(git config --get "branch.$BRANCH.pushRemote" || git config --get remote.pushDefault || git config --get "branch.$BRANCH.remote" || true)
[ -n "$FEATURE_REMOTE" ] && [ "$FEATURE_REMOTE" != "." ] || { echo "Error: feature branch has no deletion-safe remote" >&2; exit 1; }
FEATURE_REMOTE_URL=$(git remote get-url --push "$FEATURE_REMOTE") || { echo "Error: could not resolve push URL for $FEATURE_REMOTE" >&2; exit 1; }
FEATURE_REPO=$(gh repo view "$FEATURE_REMOTE_URL" --json nameWithOwner -q .nameWithOwner) || { echo "Error: could not resolve GitHub repository for $FEATURE_REMOTE" >&2; exit 1; }
FEATURE_REPO_URL=$(gh repo view "$FEATURE_REPO" --json url -q .url) || { echo "Error: could not resolve HTTPS URL for $FEATURE_REPO" >&2; exit 1; }
PR_LINES=$(gh pr list --head "$BRANCH" --state open --json number,headRepository --template '{{range .}}{{.number}} {{.headRepository.nameWithOwner}}{{"\n"}}{{end}}' -R "$REPO") || { echo "Error: could not list PRs for $BRANCH" >&2; exit 1; }
PR_NUMBER=$(printf '%s\n' "$PR_LINES" | awk -v repository="$FEATURE_REPO" '$2 == repository { print $1 }')
[ "$(printf '%s\n' "$PR_NUMBER" | awk 'NF { count++ } END { print count + 0 }')" -eq 1 ] || { echo "Error: expected exactly one open PR from $FEATURE_REPO for branch $BRANCH" >&2; exit 1; }
PR_HEAD_REPO=$(gh pr view "$PR_NUMBER" --json headRepository -q .headRepository.nameWithOwner -R "$REPO")
[ "$PR_HEAD_REPO" = "$FEATURE_REPO" ] || { echo "Error: PR head repository does not match $FEATURE_REMOTE" >&2; exit 1; }

# The branch to return to is the PR's base — NOT necessarily the default branch.
BASE_BRANCH=$(gh pr view "$PR_NUMBER" --json baseRefName -q .baseRefName -R "$REPO")
[ -n "$BASE_BRANCH" ] || { echo "Error: could not resolve base branch for PR #$PR_NUMBER" >&2; exit 1; }

PR_HEAD_SHA=$(gh pr view "$PR_NUMBER" --json headRefOid -q .headRefOid -R "$REPO")
[ -n "$PR_HEAD_SHA" ] || { echo "Error: could not resolve PR head SHA" >&2; exit 1; }
```

Pass `-R "$REPO"` to every `gh` call here, as the tool does internally. On a fork
or multi-remote checkout, an unqualified `gh` can resolve to a different repo than
the one the tool merges into — and in this skill those lookups gate a branch
deletion.

**Return to the PR's base branch, not the repository default.** They coincide for
a PR opened by `open-pr` (which bases on the default), but a stacked PR or a
release-branch PR merges somewhere else. Switching to the default there would
fast-forward a branch that never received the commits and then delete the feature
branch on the strength of a merge that landed elsewhere. The `MERGED` gate does
not catch this — it confirms the PR merged, not that *this* branch contains it.
The `$BRANCH` != `$DEFAULT_BRANCH` preflight above is a separate guard and stays
as-is.

## Workflow

1. **Determine the subject**: If the user supplied a subject, use it verbatim.
   Otherwise the tool falls back to the PR title. Do not compose a body or
   extended message — the squash commit is the subject line only. Do not append
   the `(#<pr>)` reference by hand; the tool adds it (see below).

2. **Run the reviewed merge**:

   ```bash
   bun "$AGENT_TOOL" squashMerge 'feat(app): add widget'
   # or, to default to the PR title:
   bun "$AGENT_TOOL" squashMerge
   # or, bind the merge to a reviewed head/base pair:
   bun "$AGENT_TOOL" squashMerge 'feat(app): add widget' "$REVIEWED_SHA" "$REVIEWED_BASE_SHA"
   ```

   **Quote the subject in single quotes** so the shell does not expand
   `$(...)`, backticks, or `$VAR` before the tool sees it — the subject must
   reach `commitlint`/`gh` only as a literal argv value. If the subject itself
   contains a single quote, escape it (`'\''`) or omit the argument to use the
   PR title.

   The tool:
   - Resolves the open PR for the current branch.
   - Requires the reviewed head and base SHAs together. The guarded form refuses
     to merge when either no longer matches the PR snapshot.
   - Rejects a subject that spans multiple lines (upholds the subject-only
     guarantee).
   - Validates the subject — with any trailing `(#<n>)` stripped first — using
     the repo's commitlint setup (the same `@commitlint/cli` binary and
     `commitlint.config.mts` the commit-msg hook uses). Conventional-commit
     syntax and the 50-character header limit are enforced on the human-authored
     subject; the appended PR reference is excluded from that limit, exactly as
     GitHub's server-side suffix is. If validation fails it prints commitlint's
     report and exits non-zero **without merging**.
   - Appends the PR reference so the subject ends with a space followed by
     `(#<pr>)`, replacing any existing trailing `(#<n>)` (idempotent on
     re-runs), and asserts the suffix is present before merging.
   - With both reviewed SHAs, fetches and ancestry-checks the reviewed base,
     requires a fresh GitHub snapshot to report the same head and base, and runs
     `gh pr merge --squash --match-head-commit <reviewed-head>`. GitHub performs
     the final head comparison and enforces draft, review, status, mergeability,
     and repository policy atomically with its merge mutation.
   - Without review guards, runs the legacy manual path:
     `gh pr merge --squash --subject <subject-with-#pr> --body ""`.
   - Confirms the PR reached the `MERGED` state.

3. **On a validation failure**: relay commitlint's output, propose a corrected
   subject that satisfies the rules (valid type, ≤50 chars), and re-run with the
   corrected subject once confirmed.

4. **Return to the base branch and delete the merged branch**: skip this entire
   step when `--keep-branch` was given, or when the merge did not succeed.

   **Confirm the merge from GitHub first — this is the safety gate.** Never
   delete a branch on the strength of a zero exit code alone:

   ```bash
   PR_STATE=$(gh pr view "$PR_NUMBER" --json state -q .state -R "$REPO")
   [ "$PR_STATE" = "MERGED" ] || { echo "Error: PR #$PR_NUMBER is $PR_STATE, not MERGED; skipping cleanup" >&2; exit 1; }
   ```

   If the PR is not `MERGED` (queued, blocked, or the head moved off
   `--match-head-commit`), leave the branch and the checkout exactly as they are
   and report that instead.

   **Refuse to switch away from a dirty worktree**, so unrelated in-progress work
   is never carried onto the base branch or stranded:

   ```bash
   [ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "Error: worktree has uncommitted changes; skipping cleanup" >&2; git status --short; exit 1; }
   ```

   Report the dirty paths and stop; the PR is already merged, so cleanup can be
   re-run by hand once the tree is clean. Untracked files are excluded — they
   follow a `git switch` harmlessly, and the guarded `git pull` below still stops
   if one would be overwritten.

   Then switch, fast-forward, **verify the merge actually arrived**, and only then
   delete — in this order, and **guard every step**, so a failure stops the
   sequence instead of falling through to the delete:

   ```bash
   MERGED_BRANCH="$BRANCH"
   MERGE_COMMIT=$(gh pr view "$PR_NUMBER" --json mergeCommit -q .mergeCommit.oid -R "$REPO")

   git switch "$BASE_BRANCH" || { echo "Error: could not switch to $BASE_BRANCH" >&2; exit 1; }
   git -c credential.helper= -c 'credential.helper=!gh auth git-credential' fetch "$BASE_REPO_URL" "$BASE_BRANCH" || { echo "Error: could not fetch $REPO:$BASE_BRANCH; skipping delete" >&2; exit 1; }
   git merge --ff-only FETCH_HEAD || { echo "Error: $BASE_BRANCH could not fast-forward to $REPO:$BASE_BRANCH; skipping delete" >&2; exit 1; }

   # The real gate on the delete: prove this branch now contains the squash commit.
   [ -n "$MERGE_COMMIT" ] || { echo "Error: could not resolve merge commit; skipping delete" >&2; exit 1; }
   git merge-base --is-ancestor "$MERGE_COMMIT" HEAD || { echo "Error: $BASE_BRANCH does not contain merge commit $MERGE_COMMIT; skipping delete" >&2; exit 1; }

   MERGED_HEAD_SHA=$(gh pr view "$PR_NUMBER" --json headRefOid -q .headRefOid -R "$REPO")
   REMOTE_BRANCH_SHA=$(git ls-remote --heads "$FEATURE_REPO_URL" "$MERGED_BRANCH" | awk 'NR == 1 { print $1 }')
   if [ -n "$REMOTE_BRANCH_SHA" ]; then
     [ "$REMOTE_BRANCH_SHA" = "$MERGED_HEAD_SHA" ] || { echo "Error: $FEATURE_REMOTE/$MERGED_BRANCH is $REMOTE_BRANCH_SHA, not merged PR head $MERGED_HEAD_SHA; refusing remote delete" >&2; exit 1; }
     git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push --force-with-lease="refs/heads/$MERGED_BRANCH:$REMOTE_BRANCH_SHA" "$FEATURE_REPO_URL" ":refs/heads/$MERGED_BRANCH" || { echo "Error: could not lease-delete $FEATURE_REMOTE/$MERGED_BRANCH" >&2; exit 1; }
   fi
   git branch -D "$MERGED_BRANCH" || { echo "Error: could not delete local $MERGED_BRANCH" >&2; exit 1; }
   ```

   - **Switch before deleting** — git refuses to delete the branch that is
     checked out.
   - **`--ff-only`** — the base branch must never acquire a merge commit here.
     A non-fast-forward means it has diverged locally; stop and report rather
     than reconciling. The guard is what makes that happen: without it the
     sequence would continue and delete the branch anyway.
   - **Verify the merge commit is an ancestor of `HEAD`** before deleting
     anything. This is what makes the delete safe in practice: it proves the
     branch you just pulled genuinely contains the squashed work, catching a pull
     from the wrong remote, a stale fork, or a base that never received the merge
     — none of which the `MERGED` state alone can detect.
   - **Remote deletion uses the feature branch's own remote, never the base
     branch's remote.** Before deletion, its branch SHA must equal GitHub's
     post-merge PR head, and the delete itself carries an exact force-with-lease
     for that SHA. A commit pushed between lookup and delete makes the remote
     reject the deletion. An empty lookup means GitHub already deleted the
     feature branch and is treated as success.
   - **`-D`, not `-d`, is required here** — see the note below. The `MERGED` check
     plus the ancestry check above are what make the force safe.

5. **Report results**: state the merged PR number, the final merge subject
   (including the `(#<pr>)` reference), and confirm the merge succeeded. Name the
   base branch returned to, that it was fast-forwarded and verified to contain the
   merge commit, and that the merged branch was deleted (locally, and remotely when
   it still existed) — or why cleanup was skipped.

## Notes

- The commit message is the subject only; no `--body` content is added, and
  multi-line subjects are rejected.
- The final subject always ends with a space followed by `(#<pr>)`; the tool
  appends and asserts it, and the reference is excluded from the 50-char
  commitlint header limit.
- Validation runs before the merge, so an invalid subject never reaches GitHub.
- Always single-quote the subject argument to avoid shell expansion.
- A non-zero exit after `gh pr merge` means the PR did not actually merge (e.g.
  it was queued or blocked); do not report success in that case, and do not clean
  up the branch.
- Cleanup uses `git branch -D` because a squashed feature tip is not an ancestor
  of the new base commit. It remains safe because cleanup is gated on GitHub
  reporting `MERGED` and on the base containing GitHub's merge commit.
- The tool itself does not delete the branch or change the checkout, and knows
  nothing of `--keep-branch`; step 4 of this skill owns all of that. A caller that
  invokes the tool directly gets the merge **without** the cleanup.
