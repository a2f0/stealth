---
name: cross-agent-review
description: Review the current branch — before or after its PR is opened — with another AI agent (Claude Code by default, or a fresh Codex self-review) and repair blocking findings in bounded rounds
---

# Cross-Agent Review

Review the current branch with another AI agent, then repair the blocking
findings it raises. The branch need not have a PR yet: with **no open PR** the
diff is taken against the default branch and repairs are committed locally; with
an **open PR** the pushed head is reviewed and repairs are pushed to it. Invoked
from Codex, this solicits a review from Claude Code by default, or a fresh Codex
self-review. Falls back to an in-session review when no external agent is
available.

This skill owns the full **review → repair → re-review** loop and the severity
gate that drives it. Each review round first brings the branch up to date with
its base — a merge of the latest base, never a rebase — so the review reflects the
branch as it will actually merge, not a stale snapshot. Repairs are bounded by
`--repair-rounds` (default `2`); each round changes the branch once and is
followed by a fresh review of the new head, so the reported head is always a head
that was itself reviewed. Pass `--repair-rounds 0` for a report-only review that
changes nothing; report-only mode requires the branch to already contain the
freshly fetched base so its reported base/head pair is actually shippable.

## Arguments

- First argument (optional): `claude` or `codex`. Defaults to `claude` (the
  other agent when invoked from Codex).
- Second argument (optional): the reviewer's reasoning **effort level** — one of
  `low`, `medium`, `high`, `xhigh`, `max`. When omitted it defaults **per agent**:
  **`xhigh` for Claude**, **`high` for Codex**. An unknown level fails fast
  before the reviewer CLI is launched.

  The level is passed as `claude --effort <level>` and, for Codex, as
  `-c model_reasoning_effort="<level>"` — an explicit override, so a Codex review
  never silently inherits whatever `~/.codex/config.toml` sets.
- `--passes <n>` (optional flag, position-independent): how many review passes to
  run over **one unchanged head**. **Defaults to `1`**. Passes buy discovery
  depth on a single diff; they never fix anything. A flag rather than a third
  positional argument, so it can be given without also supplying the agent and
  effort.
- `--repair-rounds <n>` (optional flag, position-independent): maximum
  blocking-finding repair rounds. **Defaults to `2`**. Each round may change the
  branch once and therefore requires a fresh review of the new head. **Use `0`
  for a report-only review** — findings are surfaced and nothing is touched.

`--passes` and `--repair-rounds` are different axes: passes re-read the same
commit, repair rounds produce new commits to read.

## Prerequisites

- `git`, `gh` (authenticated), `awk`, `realpath`, and `tar` on `PATH`.
- The `@tearleads/agent-tool` package in the fetched base commit. During the
  package's initial bootstrap PR only, set `TEARLEADS_AGENT_TOOL_DIR` to an
  independently trusted installation outside the repository checkout.
- For Claude Code reviews: `claude` CLI with `ANTHROPIC_API_KEY` available;
  bare mode intentionally does not read OAuth/keychain credentials.
- For Codex reviews: `codex` CLI configured (`OPENAI_API_KEY`).
- A feature branch (not the default branch) with commits to review. A PR **may
  or may not** exist: with an open PR, local `HEAD` must equal the pushed PR
  head, and repairs are pushed to it; with no PR, the branch is reviewed against
  the repository's default branch and repairs stay local until the PR is opened.
- The worktree is clean, including untracked files. Reviews inspect committed
  `base...HEAD` content only; allowing local changes would let `open-pr` commit
  and push content that the reviewer never saw. Commit intended changes before
  invoking this skill, including in report-only mode.

## Setup

Resolve the branch, repo, PR, and tool path:

```bash
ROOT_DIR=$(realpath "$(git rev-parse --show-toplevel)")
BRANCH=$(git rev-parse --abbrev-ref HEAD)
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)
FEATURE_REMOTE=$(git config --get "branch.$BRANCH.pushRemote" || git config --get remote.pushDefault || git config --get "branch.$BRANCH.remote" || true)
if [ -z "$FEATURE_REMOTE" ]; then
  git remote get-url origin >/dev/null 2>&1 && FEATURE_REMOTE=origin
  [ -n "$FEATURE_REMOTE" ] || [ "$(git remote | awk 'NF { count++; remote=$0 } END { print count + 0 }')" -ne 1 ] || FEATURE_REMOTE=$(git remote)
fi
FEATURE_REPO=""
if [ -n "$FEATURE_REMOTE" ] && [ "$FEATURE_REMOTE" != "." ]; then
  FEATURE_REMOTE_URL=$(git remote get-url --push "$FEATURE_REMOTE") || { echo "Error: could not resolve push URL for remote $FEATURE_REMOTE" >&2; exit 1; }
  FEATURE_REPO=$(gh repo view "$FEATURE_REMOTE_URL" --json nameWithOwner -q .nameWithOwner) || { echo "Error: could not resolve GitHub repository for remote $FEATURE_REMOTE" >&2; exit 1; }
fi
PR_LINES=$(gh pr list --head "$BRANCH" --state open --json number,headRepository --template '{{range .}}{{.number}} {{.headRepository.nameWithOwner}}{{"\n"}}{{end}}' -R "$REPO") || { echo "Error: could not query open PRs for $BRANCH (is gh authenticated?)" >&2; exit 1; }
[ -z "$PR_LINES" ] || [ -n "$FEATURE_REPO" ] || { echo "Error: same-named fork PRs exist, but this branch has no GitHub push repository" >&2; exit 1; }
PR_NUMBER=$(printf '%s\n' "$PR_LINES" | awk -v repository="$FEATURE_REPO" '$2 == repository { print $1 }')
[ "$(printf '%s\n' "$PR_NUMBER" | awk 'NF { count++ } END { print count + 0 }')" -le 1 ] || { echo "Error: multiple PRs match $FEATURE_REPO:$BRANCH" >&2; exit 1; }
BUN_BIN=$(command -v bun) || { echo "Error: bun is unavailable" >&2; exit 1; }
BUN_BIN=$(realpath "$BUN_BIN") || { echo "Error: bun path is invalid" >&2; exit 1; }
case "$BUN_BIN" in
  "$ROOT_DIR" | "$ROOT_DIR"/*) echo "Error: refusing branch-controlled bun executable" >&2; exit 1 ;;
esac
TRUSTED_AGENT_TOOL_TMP=""
```

If `$BRANCH` equals `$DEFAULT_BRANCH` (or a conventional `main`/`master`), report
the error and stop — there is nothing to review. An **empty `$PR_NUMBER` is not
an error**: it means the branch has no PR yet, and the review runs against
`$DEFAULT_BRANCH` with repairs kept local. A **failed** lookup is different — the
command above stops rather than reading a transient `gh` error as "no PR", which
would silently reroute the review to the wrong base and skip the pushed-head
checks. Same-named branches from other forks are ignored; a PR is selected only
when its head repository matches this branch's push repository.

Require a clean worktree before fetching or snapshotting anything:

```bash
[ -z "$(git status --porcelain --untracked-files=all)" ] || { echo "Error: worktree has uncommitted or untracked changes; commit intended review content first" >&2; git status --short; exit 1; }
```

## Workflow

1. **Determine agent and initialize the loop**: Parse the argument:
   - `codex` → Codex (self-review)
   - otherwise → Claude Code (default for Codex invoking this skill)

   Then set `REPAIR_ROUNDS` to the parsed maximum (default `2`) and
   `REPAIR_ROUND=0`. **This happens once, here — never inside the loop.** Steps
   2–5 form a loop that re-enters at step 2, so a counter initialized there would
   reset on every repair, the `--repair-rounds` bound would never advance, and
   the loop could commit and push without limit.

2. **Sync with the base, then snapshot the candidate head**: before reviewing,
   bring the branch up to date with its base, so the review — and the head that
   is eventually merged — reflects the branch integrated with the *current* base
   rather than a stale one. **Skip the sync under `--repair-rounds 0`**, whose
   contract is to change nothing; take the snapshot as-is in that mode.

   Resolve the base ref and fetch it:

   ```bash
   if [ -n "$PR_NUMBER" ]; then
     BASE_INFO=$(gh pr view "$PR_NUMBER" --json baseRefName,baseRefOid -q '.baseRefName + " " + .baseRefOid' -R "$REPO")
     BASE_REF=${BASE_INFO%% *}
     BASE_OID=${BASE_INFO##* }
   else
     BASE_REF="$DEFAULT_BRANCH"
     BASE_OID=""
   fi
   BASE_URL=$(gh repo view "$REPO" --json url -q .url) || { echo "Error: could not resolve the base repository URL" >&2; exit 1; }
   git fetch "$BASE_URL" "$BASE_REF" || { echo "Error: could not fetch $BASE_REF from $BASE_URL" >&2; exit 1; }
   FETCHED_BASE=$(git rev-parse 'FETCH_HEAD^{commit}') || { echo "Error: fetched base commit is unavailable" >&2; exit 1; }
   [ -z "$BASE_OID" ] || [ "$FETCHED_BASE" = "$BASE_OID" ] || { echo "Error: fetched $FETCHED_BASE but PR base snapshot was $BASE_OID; retry" >&2; exit 1; }

   # Never execute the feature branch's launcher: it runs before the reviewer
   # sandbox and inherits credentials. Materialize the tool from the fetched,
   # trusted base. The explicit external path exists only to bootstrap the first
   # PR that introduces the package; it must resolve outside this checkout.
   if [ -n "$TRUSTED_AGENT_TOOL_TMP" ]; then
     rm -rf "$TRUSTED_AGENT_TOOL_TMP"
     TRUSTED_AGENT_TOOL_TMP=""
   fi
   if git cat-file -e "$FETCHED_BASE:packages/agent-tool/src/index.ts" 2>/dev/null; then
     TRUSTED_AGENT_TOOL_TMP=$(mktemp -d "${TMPDIR:-/tmp}/tearleads-agent-tool.XXXXXX") || exit 1
     trap 'if [ -n "$TRUSTED_AGENT_TOOL_TMP" ]; then rm -rf "$TRUSTED_AGENT_TOOL_TMP"; fi' EXIT
     git archive "$FETCHED_BASE" packages/agent-tool | tar -x -C "$TRUSTED_AGENT_TOOL_TMP" || { echo "Error: could not materialize the base agent-tool" >&2; exit 1; }
     AGENT_TOOL="$TRUSTED_AGENT_TOOL_TMP/packages/agent-tool/src/index.ts"
   else
     [ -n "${TEARLEADS_AGENT_TOOL_DIR:-}" ] || { echo "Error: base has no agent-tool; set TEARLEADS_AGENT_TOOL_DIR to a trusted external installation" >&2; exit 1; }
     AGENT_TOOL=$(realpath "$TEARLEADS_AGENT_TOOL_DIR/src/index.ts") || { echo "Error: trusted agent-tool path is invalid" >&2; exit 1; }
     case "$AGENT_TOOL" in
       "$ROOT_DIR" | "$ROOT_DIR"/*) echo "Error: trusted agent-tool must be outside the feature checkout" >&2; exit 1 ;;
     esac
   fi
   [ -f "$AGENT_TOOL" ] || { echo "Error: trusted agent-tool not found at $AGENT_TOOL" >&2; exit 1; }
   if [ "$REPAIR_ROUNDS" -eq 0 ]; then
     git merge-base --is-ancestor "$FETCHED_BASE" HEAD || { echo "Error: report-only review cannot ship a branch behind $BASE_REF; sync it and run a fresh review" >&2; exit 1; }
   fi
   ```

   **When a PR is open**, confirm the local head is already the pushed head
   *before* the sync changes anything — otherwise the push below would publish
   unpushed local commits and the after-the-fact check would rubber-stamp them,
   masking the very mismatch that check exists to catch:

   ```bash
   if [ -n "$PR_NUMBER" ]; then
     PR_HEAD_REPO=$(gh pr view "$PR_NUMBER" --json headRepository -q .headRepository.nameWithOwner -R "$REPO") || { echo "Error: could not resolve the PR head repository" >&2; exit 1; }
     [ -n "$FEATURE_REMOTE" ] && [ "$FEATURE_REMOTE" != "." ] && [ "$FEATURE_REPO" = "$PR_HEAD_REPO" ] || { echo "Error: PR #$PR_NUMBER does not belong to the branch push remote" >&2; exit 1; }
     test "$(git rev-parse HEAD)" = "$(gh pr view "$PR_NUMBER" --json headRefOid -q .headRefOid -R "$REPO")" || { echo "Error: local HEAD is not the pushed head of PR #$PR_NUMBER; reconcile before reviewing" >&2; exit 1; }
   fi
   ```

   Then **merge** the exact fetched base in — merge `$FETCHED_BASE`, which was
   validated against the PR snapshot when a PR is open, rather than an ambient
   remote-tracking ref that may belong to a stale fork:

   ```bash
   PRE_SYNC_HEAD=$(git rev-parse HEAD)
   git merge --no-edit "$FETCHED_BASE" || {
     git merge --abort
     echo "Error: merging the latest $BASE_REF into $BRANCH conflicts — resolve it and re-run" >&2
     exit 1
   }
   ```

   **Merge, not rebase, and never force.** Every branch mutation in these skills
   pushes without force, and a rebase would need a force push; the squash-merge
   flattens the merge commit anyway, so it costs nothing in the final history. **On
   a conflict, abort and stop** — never auto-resolve, and never review a conflicted
   tree.

   The merge moves `HEAD` only when the base actually advanced; on a branch
   already current, or a later repair round where nothing new landed, it is a
   no-op. **When a PR is open**, push the updated head without force so the
   pushed head still matches what is reviewed — but **only when the merge
   actually moved `HEAD`**, so an already-current branch does not fire the
   (expensive) pre-push hook for nothing; **with no PR**, the merge stays local
   and `open-pr` pushes it later, so the flow's single push is preserved:

   ```bash
   if [ -n "$PR_NUMBER" ] && [ "$(git rev-parse HEAD)" != "$PRE_SYNC_HEAD" ]; then
     git push "$FEATURE_REMOTE" "HEAD:$BRANCH"
   fi
   ```

   Then snapshot the head under review — the integrated head when the sync ran,
   the current head when it was skipped:

   ```bash
   REVIEWED_SHA=$(git rev-parse HEAD)
   ```

   **With no PR**, nothing is pushed to compare against; the local snapshot is the
   head under review, and `open-pr` later pushes it unchanged, exactly as reviewed.
   **With a PR**, the head just pushed is the reviewed head.

3. **Run the review**: Execute the matching action over the snapshot head. Omit
   the effort argument to take the per-agent default (`xhigh` for Claude, `high`
   for Codex); pass a level to override it.

   With `--passes <n>` and `n > 1`, repeat the review over the *same, unchanged*
   head, reporting only findings the earlier passes did not surface, and stop
   early as soon as a pass adds nothing new.

   **For Claude Code review:**

   ```bash
   "$BUN_BIN" "$AGENT_TOOL" solicitClaudeCodeReview xhigh "$FETCHED_BASE"
   "$BUN_BIN" "$AGENT_TOOL" solicitClaudeCodeReview high "$FETCHED_BASE"
   ```

   **For Codex review:**

   ```bash
   "$BUN_BIN" "$AGENT_TOOL" solicitCodexReview high "$FETCHED_BASE"
   "$BUN_BIN" "$AGENT_TOOL" solicitCodexReview xhigh "$FETCHED_BASE"
   ```

   **Fallback behavior (required):**

   - If the Claude Code review fails for **any** reason (credit/quota errors,
     non-zero exit, signal termination, or a failed verdict gate after the
     tool's built-in retry), immediately fall back to a Codex self-review:

     ```bash
     "$BUN_BIN" "$AGENT_TOOL" solicitCodexReview high "$FETCHED_BASE"
     ```

   - If the Codex review also fails (or was selected first and fails due to
     credits/quota/auth or prompt-size limits), perform an **in-session
     file-by-file review** (step 4).

   - Only stop immediately for non-recoverable operational errors (missing PR,
     missing tool script, malformed args) where fallback would also fail.

   - If every agent and fallback fails, report that the review **could not run**
     and stop. Never repair against a review that does not exist.

   **What counts as a usable review:** a reviewer CLI can exit **0** having
   produced only an intent sentence — "I'll review this PR diff..." — which is not
   a review. Never relay one as if it were, and never repair from one.

   **Both directions are guarded the same way.** This repo writes both review
   prompts, so every review — Claude or Codex — must end with a `VERDICT:` line
   (`BLOCKER`, `MAJOR`, `MINOR`, `SUGGESTION`, or `CLEAN`). Both solicit actions
   check for it, retry once when the CLI exits 0 without one (that failure is
   stochastic), and exit nonzero when the retry also fails — so the fallback
   chain above fires on its own. Codex runs through `codex exec` against a
   tracked-files-only temporary checkout under a least-privilege filesystem
   profile, and only its final message is relayed, so the captured output is the
   review, never the investigative transcript. The verdict is a
   completion sentinel, not proof of quality — still read the findings before
   repairing from them.

   After review, confirm the head is still the snapshot:

   ```bash
   test "$REVIEWED_SHA" = "$(git rev-parse HEAD)"
   [ -z "$PR_NUMBER" ] || test "$REVIEWED_SHA" = "$(gh pr view "$PR_NUMBER" --json headRefOid -q .headRefOid)"
   git fetch "$BASE_URL" "$BASE_REF" || { echo "Error: could not re-fetch $BASE_REF after review" >&2; exit 1; }
   POST_REVIEW_BASE=$(git rev-parse 'FETCH_HEAD^{commit}') || { echo "Error: post-review base is unavailable" >&2; exit 1; }
   test "$FETCHED_BASE" = "$POST_REVIEW_BASE" || { echo "Error: $BASE_REF moved during review; discard the result and re-run" >&2; exit 1; }
   ```

   If the head or pinned base changed, something landed underneath the review.
   Discard the stale result, reconcile safely, and return to step 2. These checks
   run *before* any repair of this round, so they detect foreign changes rather
   than the skill's own. With no PR there is no pushed head to check, only the
   local one; the base re-fetch is required in both modes.

4. **In-session file-by-file review** (when external agents are unavailable):

   **CRITICAL: Never compute the full PR diff in a single pass.** Large diffs
   exceed prompt limits and cause partial/failed reviews. Interrogate GitHub and
   review file-by-file:

   a. Reuse the exact base SHA fetched and validated in step 2, so the file list
      is the branch's own work even when an ambient remote-tracking ref is stale:

      ```bash
      BASE="$FETCHED_BASE"
      REVIEW_FILE_LIST=$(mktemp)
      git diff --name-only -z "$BASE"...HEAD > "$REVIEW_FILE_LIST"
      ```

      Consume `$REVIEW_FILE_LIST` with a NUL-aware reader and keep each decoded
      pathname as one value. Never put this output in command substitution or
      split it on lines: Git permits tabs and newlines in tracked pathnames.

   b. For each exact pathname decoded by that NUL-aware reader, get the per-file
      diff against the same `$BASE` (with `$FILE_PATH` passed as one quoted
      argument):

      ```bash
      git diff "$BASE"...HEAD -- "$FILE_PATH"
      ```

      Remove `$REVIEW_FILE_LIST` after the last path is reviewed.

   c. For added or modified files, read the file with native file-reading tools
      for full context. Deleted files do not need to be read.

   d. Review each file against the project's guidelines (`REVIEW.md` if present,
      otherwise `AGENTS.md`):
      - Flag security issues, type safety violations, and missing tests as high
        priority.
      - Use severity levels: Blocker, Major, Minor, Suggestion.
      - Be concise: one line per issue with a `file:line` reference.

   e. Aggregate findings across all files into the final review output.

5. **Review gate and bounded repair**: read the findings and classify them.
   Every reviewer is prompted for **Blocker / Major / Minor / Suggestion**; if a
   review nonetheless speaks in **[P0]–[P3]**, treat them as one scale —
   **Blocker ≡ [P0]**, **Major ≡ [P1]**, **Minor ≡ [P2]**, **Suggestion ≡ [P3]**
   — where **Blocker/Major (P0/P1) count as blocking**.

   - If the review is **clean or raises only non-blocking nits**
     (**Minor/Suggestion** or **[P2]/[P3]**), the loop is done. `REVIEWED_SHA` is
     the final reviewed head.
   - If the review raises a **blocking** finding, surface it. Then:
     - If `--repair-rounds 0` was given, **stop and report** the findings without
       touching the branch. This is the report-only mode.
     - If `REPAIR_ROUND` has reached `--repair-rounds`, **stop and report** the
       unresolved findings along with the rounds already performed.
     - Otherwise repair:
       1. Confirm each fix is actionable, in scope, and requires no new authority
          or material user choice. Stop and ask for direction when that is false.
       2. Implement all blocking fixes. Also address directly adjacent
          non-blocking findings when doing so is low-risk and avoids dead code or
          vacuous tests; do not expand the PR into unrelated cleanup.
       3. Run validation proportionate to the changes, including the repository's
          staged source-shape check before committing.
       4. Stage only the repair paths and commit with a valid conventional
          subject. **When a PR is open, push without force** so the pushed head
          tracks the repair; **with no PR, do not push** — the repairs stay local
          and are pushed once, later, when the PR is opened. Stop if unrelated
          changes are mixed into the worktree.
       5. Increment `REPAIR_ROUND` — never reset it — and return to **step 2**,
          not step 1, so the new head is snapshotted and the **complete** PR diff
          is reviewed again while the round count survives.

   **Never report a head as reviewed after fixing it.** Every repair round ends
   by re-entering the loop; the reported `REVIEWED_SHA` is always a head that a
   review actually read.

6. **Report results**: Output
   - Which agent performed the review (and whether fallback was used, and why)
   - The PR number and branch
   - The review findings from the final review
   - **The head SHA** — normally `REVIEWED_SHA`, a head a review actually read.
     With an open PR it is the pushed head; with no PR it is a local, not-yet-
     pushed head that `open-pr` will push unchanged. On a
     **review-could-not-run** verdict nothing was reviewed, so report the
     **candidate** head snapshotted in step 2 and label it plainly as
     *unreviewed*. Always report a SHA: a caller overriding the gate still needs
     a head to bind its merge to, and inventing one later would defeat the bind.
   - **The base SHA** — `FETCHED_BASE`, the exact base commit merged before and
     used by the final review round. Label it `REVIEWED_BASE_SHA` for callers.
   - **The final verdict** — clean, non-blocking nits only, unresolved blocking
     findings, or review-could-not-run
   - **Repair rounds performed**, and what was fixed in them

   Callers gate on the last four. `ship-pr` binds its merge to the reported head
   and base SHAs and refuses to merge on an unresolved-blocking or could-not-run
   verdict unless it was told to override.

## Notes

- **Repairs are bounded** — at most two branch-changing repair rounds by default.
  The bound is what keeps a review → fix → re-review cycle from running away and
  surfacing ever-narrower findings; it is the reason this loop can be safe to own
  here at all. `--repair-rounds 0` disables repair entirely and restores the
  report-only review.
- **`--passes` and `--repair-rounds` are orthogonal.** `--passes` controls
  discovery depth on one unchanged head and never mutates anything;
  `--repair-rounds` bounds how many times the branch may change and be
  re-reviewed. Raising passes makes each look deeper; raising repair rounds makes
  the loop longer.
- **The reported head is a reviewed head.** `REVIEWED_SHA` is snapshotted before
  the review, verified unchanged after it, and re-snapshotted after every repair
  round — pushed when a PR is open, local when there is none. A caller that
  merges the reported SHA (after pushing it, if it was local) merges a commit that
  was reviewed.
- **The reported base is the reviewed base.** `REVIEWED_BASE_SHA` is the exact
  fetched commit merged before the final review. A caller must re-sync and
  re-review if the PR base moves away from it before merge. Report-only mode
  refuses to review when that fetched base is not already an ancestor of the
  candidate, so it cannot report a knowingly unshippable pair.
- **A failed review is not a clean review.** If every agent and fallback fails,
  the verdict is *could-not-run* and no repair happens — repairing against absent
  findings would be inventing work.
- Effort defaults are per agent — `xhigh` for Claude, `high` for Codex — and are
  always passed explicitly, so neither reviewer inherits an ambient config value.
  Fallback reviews use the fallback agent's own default unless a level is given.
- The fallback chain is not a second pass: falling back to another agent (or the
  in-session review) is still the *same* single pass, because the first reviewer
  produced no usable result.
- The review scripts are non-interactive and stream output to stdout.
- Reviews are based on the diff between the base branch and HEAD — the PR's base
  when a PR is open, the repository's default branch when there is none yet.
- Review policy (`REVIEW.md`, falling back to `AGENTS.md`) is loaded from the
  fetched base commit, never from the contributor-controlled feature tree.
- **Each round merges the current base into the branch first**, so a branch cut
  from an older base is reviewed as it will actually merge — a signature change
  or a moved dependency that landed on the base surfaces during the review and
  the pre-push checks, not after the merge. The merge (never a rebase, so no
  force push) is local when there is no PR and pushed when there is; a conflict
  aborts and stops for the user. `--repair-rounds 0` skips it, keeping
  report-only inert, and refuses to proceed unless the current head already
  contains the freshly fetched base.
- Both reviewers get the prompt/diff via stdin (not argv) to avoid
  "Argument list too long" failures on large PRs.
- The Claude reviewer runs in `--bare --safe-mode`, disabling project hooks,
  plugins, settings, MCP servers, keychain access, persistence, and other
  customizations. It gets only read-only tools
  (`--tools "Read,Grep,Glob"`) and no `Bash`, inside a standalone Codex
  permission-profile sandbox over the same tracked-files-only temporary
  checkout. It needs to read:
  the best findings come from the code *around* the diff — an unchanged branch
  further up the file, a source-shape baseline, the callers a signature change
  breaks. `Bash` is withheld because a review needs no shell, and the session's
  context is a PR diff — attacker-influenceable text.
  The Codex reviewer ignores user config and disables MCP/plugin/app surfaces.
  Its primary workspace is a fresh temporary directory containing a nested
  snapshot of committed tracked blobs only. A least-privilege permission profile
  exposes only minimal runtime paths and that temporary workspace; shell
  environment inheritance is disabled. Ignored files, untracked secrets, and
  neighboring repositories are therefore unreadable, and feature-branch
  `AGENTS.md` files are not auto-loaded as policy.
  The repair rounds run in *this* session, not the reviewer's; the reviewer stays
  read-only no matter how many rounds run.
- **Why a review can come back empty is not known.** The one observed failure —
  Claude exiting 0 after ~5s having emitted only "I'll review this PR diff..." —
  was never reproduced and looks stochastic. The verdict check plus the tool's
  single retry makes it survivable; the failure is detected and retried
  rather than prevented.
- Error output should be relayed verbatim when fallback is impossible.
