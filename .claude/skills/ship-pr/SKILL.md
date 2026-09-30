---
name: ship-pr
description: Ship current work end-to-end — commit on a feature branch, patch-bump the changed backend/frontend versions, cross-agent review and repair it, open or resume its PR with a single push after the review, bring it up to date with its base, merge the verified reviewed candidate through GitHub's policy gate, then return to the base branch, delete the merged branch, and reset the checkout
---

# Ship PR

Run the full ship flow for the current work: **commit the work on a feature
branch**, get a **cross-agent review** that repairs its own blocking findings,
**open or resume its PR**, then **merge the reviewed pair** and clean up. The PR
is opened *after* the review, so a fresh branch is pushed **once**, with
feature-controlled hooks bypassed, instead of once at open time and again for
each repair round.
Delegate PR creation, the review-and-repair loop, and the final merge to the
`open-pr`, `cross-agent-review`, `squash-merge`, and `reset` skills. This skill
owns the ordering and the merge gate; it does not re-implement the wrapped
skills.

Every package the PR changes among `packages/api` (the backend) and
`packages/client` (the frontend) ships with a **patch version bump**: one past
its version on the base it merges onto, recomputed each time the branch syncs
with that base, so concurrent PRs never land the same or a backward version on
the base.

The branch is **up to date with its base when it merges**. Immediately before
the merge, a freshness gate fetches the base's actual tip; a branch that is
behind it is synced, re-bumped, and re-reviewed first, as many times as the
base moves.

The review gates the merge. `cross-agent-review` addresses actionable blocking
findings and re-reviews every head it changes, then reports the final reviewed
SHA and verdict. This skill merges that exact SHA, and only on a non-blocking
verdict. Never merge a commit that was not itself reviewed.

A successful flow ends back on the PR's base branch — the default branch for a PR
`open-pr` created — fast-forwarded, with the merged branch deleted, and with the
repo's git hooks reinstalled. That cleanup belongs to `squash-merge`, which runs
it only after GitHub confirms the PR is `MERGED` and that the base branch
actually contains the merge commit; the final checkout reset belongs to `reset`.

## Arguments

- First argument (optional): the conventional-commit title (`type(scope): …`,
  ≤50 chars), single-quoted. For a new PR, it is the PR title and default merge
  subject. For an existing PR, retain that PR's title. When omitted for a new
  PR, default to the branch's latest commit subject. **To supply a later
  positional argument while defaulting the title, pass an empty string `''`.**
- Second argument (optional): the review agent to pass to `cross-agent-review`
  (`claude` or `codex`). When omitted, that skill picks its own default — the
  *other* agent from whichever one is running this flow.
- `--passes <n>` (optional flag, position-independent): forwarded verbatim to
  `cross-agent-review`. **Defaults to `1`** there. Passes inspect one unchanged
  head; they are distinct from repair rounds.
- `--report-only` (optional flag, position-independent): forwarded verbatim
  to `cross-agent-review`, which skips base synchronization, version bumps,
  and repairs. This flow stops on any blocking finding, and before merging a
  branch that is behind its base or still needs a version bump. Without this
  flag, repairs have no round limit.
- Reject the obsolete `--repair-rounds` flag rather than ignoring it. Use
  `--report-only` for a non-mutating review or omit the flag for unlimited
  repairs.
- `--merge-anyway` (optional flag, position-independent): override the merge gate.
  By default the flow stops when `cross-agent-review` reports unresolved blocking
  findings or could not review at all; with this flag it surfaces exactly what it
  is overriding and proceeds. The reviewed-head guard still applies.
- `--keep-branch` (optional flag, position-independent): forwarded verbatim to
  `squash-merge`, which then skips the post-merge cleanup and stays on the
  feature branch. Use when the branch is still needed locally.
- The PR body is read from stdin (empty when none is piped) and passed to
  `open-pr`.

## Prerequisites

- `git` and `gh` (authenticated) on `PATH`.
- The trusted `@tearleads/agent-tool` setup required by the delegated
  `cross-agent-review`, `open-pr`, and `squash-merge` skills.
- `node_modules` installed (`bun install`) so repository checks and hooks run.
- Commit signing configured so `git commit -S` works without a prompt, and so
  git can verify the result (SSH signing also needs
  `gpg.ssh.allowedSignersFile`). Every
  push in the flow is refused while any commit in the branch is unsigned.
- macOS Seatbelt for credential-free preflights. The delegated preflight fails
  closed on another platform.
- The worktree contains only changes intended for this PR. A PR may already be
  open; this is how a prior gated run resumes after fixes.

The flow may start on the default branch. In that case step 1 performs the same
safe move `open-pr` documents — preserving the intended work, fast-forwarding the
default branch, creating a feature branch, and restoring the work there — but
**commits without pushing or opening the PR**, so the review still runs before
the single push. Each wrapped skill re-checks its own preconditions.

## Setup

```bash
REALPATH_BIN=/usr/bin/realpath
[ -x "$REALPATH_BIN" ] || REALPATH_BIN=/bin/realpath
[ -x "$REALPATH_BIN" ] || {
  echo "Error: trusted system realpath is unavailable" >&2
  exit 1
}
CHECKOUT_ROOT=$("$REALPATH_BIN" .)
while [ ! -e "$CHECKOUT_ROOT/.git" ] && [ "$CHECKOUT_ROOT" != "/" ]; do
  CHECKOUT_ROOT=${CHECKOUT_ROOT%/*}
  [ -n "$CHECKOUT_ROOT" ] || CHECKOUT_ROOT=/
done
[ -e "$CHECKOUT_ROOT/.git" ] || {
  echo "Error: could not find the checkout boundary" >&2
  exit 1
}

resolve_bootstrap_tool() {
  tool_name=${1}
  candidate=$(command -v "$tool_name") || {
    echo "Error: $tool_name is unavailable" >&2
    return 1
  }
  candidate=$("$REALPATH_BIN" "$candidate") || return 1
  case "$candidate" in
    "$CHECKOUT_ROOT" | "$CHECKOUT_ROOT"/*)
      echo "Error: refusing checkout-controlled $tool_name executable" >&2
      return 1
      ;;
  esac
  printf '%s\n' "$candidate"
}

GIT_BIN=$(resolve_bootstrap_tool git) || exit 1
GH_BIN=$(resolve_bootstrap_tool gh) || exit 1
BUN_BIN=$(resolve_bootstrap_tool bun) || exit 1
TAR_BIN=$(resolve_bootstrap_tool tar) || exit 1
# Commits are signed: keep the signing program (gpg, when installed) on PATH,
# or git can neither sign commits nor verify their signatures.
GPG_BIN=$(resolve_bootstrap_tool gpg 2>/dev/null || true)
PATH="${GIT_BIN%/*}:${GH_BIN%/*}:${BUN_BIN%/*}:${TAR_BIN%/*}${GPG_BIN:+:${GPG_BIN%/*}}:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH
ROOT_DIR=$("$REALPATH_BIN" "$(git rev-parse --show-toplevel)")
BRANCH=$(git rev-parse --abbrev-ref HEAD)
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
[ -n "$REPO" ] || { echo "Error: repository identity is unavailable" >&2; exit 1; }
DEFAULT_BRANCH=$(gh repo view "$REPO" --json defaultBranchRef -q .defaultBranchRef.name)
[ -n "$DEFAULT_BRANCH" ] || { echo "Error: repository default branch is unavailable" >&2; exit 1; }
BASE_URL=$(gh repo view "$REPO" --json url -q .url)
[ -n "$BASE_URL" ] || { echo "Error: repository fetch URL is unavailable" >&2; exit 1; }
git fetch --quiet "$BASE_URL" "$DEFAULT_BRANCH" || {
  echo "Error: could not fetch $DEFAULT_BRANCH from $BASE_URL" >&2
  exit 1
}
BASE_HEAD=$(git rev-parse --verify 'FETCH_HEAD^{commit}') || {
  echo "Error: fetched base commit is unavailable" >&2
  exit 1
}

if git cat-file -e "${BASE_HEAD}:packages/agent-tool/src/index.ts" 2>/dev/null; then
  TRUSTED_AGENT_TOOL_TMP=$(mktemp -d "${TMPDIR:-/tmp}/tearleads-agent-tool.XXXXXX") || exit 1
  trap 'rm -rf "$TRUSTED_AGENT_TOOL_TMP"' EXIT
  git archive "$BASE_HEAD" packages/agent-tool | tar -x -C "$TRUSTED_AGENT_TOOL_TMP" || { echo "Error: could not materialize the base agent-tool" >&2; exit 1; }
  AGENT_TOOL="$TRUSTED_AGENT_TOOL_TMP/packages/agent-tool/src/index.ts"
else
  [ -n "${TEARLEADS_AGENT_TOOL_DIR:-}" ] || { echo "Error: base has no agent-tool; set TEARLEADS_AGENT_TOOL_DIR to a trusted external installation" >&2; exit 1; }
  AGENT_TOOL=$(realpath "$TEARLEADS_AGENT_TOOL_DIR/src/index.ts") || { echo "Error: trusted agent-tool path is invalid" >&2; exit 1; }
  case "$AGENT_TOOL" in
    "$ROOT_DIR" | "$ROOT_DIR"/*) echo "Error: trusted agent-tool must be outside the feature checkout" >&2; exit 1 ;;
  esac
fi
[ -f "$AGENT_TOOL" ] || { echo "Error: trusted agent-tool not found at $AGENT_TOOL" >&2; exit 1; }

# `--no-verify` pushes skip the feature checkout's pre-push hook, so every push
# first runs the hook's commit-trust check itself, taken from the trusted base:
# each commit being pushed must be signed and free of Co-authored-by trailers.
# During the bootstrap PR that introduces the check, the base has no copy; set
# TEARLEADS_COMMIT_TRUST_SCRIPT to an independently trusted copy instead.
verify_commit_trust() {
  # Only a real commit may name the trusted base: an empty one would read the
  # feature branch's own copy from the index and check an empty range.
  [ -n "${1:-}" ] && trust_base=$(git rev-parse --verify --quiet "${1}^{commit}") || {
    echo "Error: verify_commit_trust needs the trusted base commit" >&2
    return 1
  }
  trust_dir=$(mktemp -d "${TMPDIR:-/tmp}/tearleads-commit-trust.XXXXXX") || return 1
  if git cat-file -e "${trust_base}:scripts/checks/checkCommitTrust.sh" 2>/dev/null; then
    git show "${trust_base}:scripts/checks/checkCommitTrust.sh" >"$trust_dir/checkCommitTrust.sh" || { rm -rf "$trust_dir"; return 1; }
    trust_script="$trust_dir/checkCommitTrust.sh"
  elif [ -n "${TEARLEADS_COMMIT_TRUST_SCRIPT:-}" ]; then
    trust_script=$("$REALPATH_BIN" "$TEARLEADS_COMMIT_TRUST_SCRIPT") || { rm -rf "$trust_dir"; return 1; }
    # Outside every worktree of this repository, not just the current one.
    if git worktree list --porcelain | awk -v script="$trust_script" 'sub(/^worktree /, "") && (script == $(0) || index(script, $(0) "/") == 1) { found = 1 } END { exit !found }'; then
      echo "Error: trusted commit-trust check must be outside every checkout of this repository" >&2
      rm -rf "$trust_dir"
      return 1
    fi
  else
    echo "Error: base has no commit-trust check; set TEARLEADS_COMMIT_TRUST_SCRIPT to a trusted copy outside the checkout" >&2
    rm -rf "$trust_dir"
    return 1
  fi
  trust_status=0
  sh "$trust_script" --range "$trust_base..HEAD" || trust_status=$?
  rm -rf "$trust_dir"
  [ "$trust_status" -eq 0 ] || { echo "Error: refusing to push unsigned or co-authored commits" >&2; return 1; }
}
```

The setup fetches the exact GitHub base and materializes `packages/agent-tool`
from that base outside the checkout. This is required even when the PR already
exists: the feature branch must never choose the process that receives GitHub
or reviewer credentials.

## Workflow

Run the wrapped skills in order. Stop on operational failures, an unresolved
blocking verdict, or an overridden-head mismatch. Let each wrapped skill own its
mechanics: quoting, commitlint validation, the review fallback chain and repair
loop, subject-only reviewed merge, and `MERGED`-state verification.

1. **Commit the work on a feature branch — no push, no PR yet**: reach a state
   where the intended work is committed on a feature branch and, in the fresh
   case, nothing is pushed and no PR exists — so the review reads local commits
   and the branch is pushed exactly once, when the PR is opened.

   First look up whether an open PR already exists for the branch, using the
   repository-matched lookup from `cross-agent-review`: match both the branch
   name and `headRepository.nameWithOwner` to the branch's resolved push remote,
   and require exactly one match. Never take the first same-named fork PR. One
   matching PR may remain from a prior gated run. Then take the matching case:

   - **A PR is already open for the branch** (a prior gated run resuming after
     fixes): do not prepare a new branch or open another PR. Confirm it targets
     the expected branch, then run the relevant preflight, stage only intended
     paths, commit any uncommitted intended work with a valid conventional
     subject, and push it without force (`--no-verify`, once
     `verify_commit_trust "$BASE_HEAD"` passes) so the pushed head carries the
     resumed work. Capture its number, URL, and title, and set `PR_NUMBER` to
     it. On this existing-PR path `cross-agent-review` reviews the pushed head
     and pushes its own repairs, and step 3 is a no-op.
   - **`$BRANCH` equals `$DEFAULT_BRANCH`**: move the work to a new feature branch
     with the same safe transition `open-pr` documents in its "Move
     default-branch work safely" step — stash tracked and untracked work, fetch,
     verify local default has not diverged, fast-forward local default, create the
     feature branch, restore the work — then run the preflight, stage only
     intended paths, and commit with a valid conventional subject. **Stop before
     pushing, and do not open a PR.** Refresh `$BRANCH` and leave `PR_NUMBER`
     empty.
   - **A feature branch with no open PR**: run the preflight, stage only intended
     paths, and commit any uncommitted intended work with a valid conventional
     subject. **Do not push.** Leave `PR_NUMBER` empty.
   - In every case, stop if unrelated changes are mixed into the worktree.

   In all three paths, "run the preflight" and "commit" mean this protected
   sequence. Run additional relevant scripts such as `test` or `build` as their
   own `runPreflight` actions:

   ```bash
   "$BUN_BIN" --no-env-file --config=/dev/null "$AGENT_TOOL" runPreflight check
   git add <intended-paths>
   git -c core.hooksPath=/dev/null commit -S -m "$COMMIT_SUBJECT"
   ```

   On the resume path only, push the committed work to the branch's push remote
   (resolved by the PR lookup above) after the same trusted commit-trust check
   every push in this flow runs:

   ```bash
   verify_commit_trust "$BASE_HEAD" || exit 1
   git push --no-verify "$FEATURE_REMOTE" "HEAD:$BRANCH"
   ```

   Skip `git add` and `git commit` when there is no uncommitted work. The
   preflight sandbox strips credentials, denies external network access, and
   blocks writes to `.git` and `node_modules`; the commit disables all
   contributor-controlled hooks and is signed, because every push in this flow
   refuses unsigned commits. Never run a branch-controlled
   package script or commit hook in this credential-bearing orchestration shell.
   Checks that inherently require local TCP (currently the Workerd upload
   integration and provider-backed Terraform validation/TFLint) explicitly skip
   only in this offline preflight. The required GitHub CI runs the complete
   versions before merge.

   If no title argument was supplied, capture the intended PR title now — the work
   commit's subject (`git log -1 --format=%s`) — and reuse it when opening the PR
   in step 3. The review may add repair commits, so letting `open-pr` default the
   title *after* the review would derive it from a repair commit's subject rather
   than the work; the squash subject would inherit that too.

   `cross-agent-review` reads the current branch either way: with `PR_NUMBER`
   empty it reviews the local commits against the default branch; with the
   resumed PR open it reviews the pushed head.

2. **Sync, bump, review, and repair** — invoke `cross-agent-review` with
   **always** `--bump-versions`, forwarding the review-agent argument, and
   `--passes <n>` / `--report-only` when given.

   That skill owns the review, the severity gate, and the repair loop:
   for each candidate head it first brings the branch up to date with its base
   (a merge of the latest base — local while there is no PR, so this flow's
   single push is preserved), commits the patch bump for each changed versioned
   package against that base, snapshots the head — the pushed PR head when one
   is open, the local HEAD otherwise — reviews it, repairs blocking findings
   (committing locally when there is no PR, pushing when there is), and
   re-reviews every head it changes. It reports back a **head SHA**, the exact
   **base SHA** used for that review, a **verdict**, the **repair rounds** it
   performed, and the **version bumps** it made. The head is reviewed on every
   verdict except **review-could-not-run**, where it is the unreviewed
   candidate head — only reachable here via `--merge-anyway`.

   Relay its output — which agent ran, whether it fell back, the findings, and
   what was repaired.

   Take its reported SHAs as `REVIEWED_SHA` and `REVIEWED_BASE_SHA`. Confirm the
   head is still local `HEAD` — and, when a PR is already open, that both the
   pushed head and PR base still match:

   ```bash
   REVIEWED_SHA=<final reviewed SHA reported by cross-agent-review>
   REVIEWED_BASE_SHA=<final base SHA reported by cross-agent-review>
   test "$REVIEWED_SHA" = "$(git rev-parse HEAD)"
   if [ -n "$PR_NUMBER" ]; then
     PR_SHAS=$(gh pr view "$PR_NUMBER" --json headRefOid,baseRefOid -q '.headRefOid + " " + .baseRefOid' -R "$REPO")
     test "$PR_SHAS" = "$REVIEWED_SHA $REVIEWED_BASE_SHA"
   fi
   ```

   If either SHA differs, a head commit or base commit landed after the loop
   finished. Discard the result, reconcile safely, and re-run
   `cross-agent-review`. Never carry stale SHAs into the later steps.

   **Merge gate** — decide on the reported verdict:
   - **Clean, or non-blocking nits only** — carry that exact `REVIEWED_SHA`
     forward to steps 3–4.
   - **Unresolved blocking findings** — because `--report-only` was given or
     the loop stopped to ask for direction —
     **stop** and report them, unless `--merge-anyway` was given. In the fresh
     path no PR was opened, so stopping here leaves nothing to clean up.
   - **Review could not run** (every agent and fallback failed) — **stop** rather
     than merge unreviewed, unless `--merge-anyway` was given. In that override
     the reported SHA is the **unreviewed candidate** head; the head checks above
     and the `--match-head-commit` bind still apply to it, so the merge is still
     pinned to a known commit — it simply is not a reviewed one. Say so.

   When `--merge-anyway` is set and the gate would otherwise stop, surface the
   blocking or unavailable findings, state plainly that the gate is being
   overridden, and proceed to steps 3–4.

   **Never repair here.** Fixing a finding in this step would produce a head that
   `cross-agent-review` never read, and `REVIEWED_SHA` would no longer describe
   the commit being merged. Return to `cross-agent-review` instead; its repair
   loop has no round limit.

3. **Open the PR — the single push, bound to the reviewed head**:

   - **No PR yet** (the fresh path, `PR_NUMBER` empty): invoke `open-pr` with the
     title argument (or the title captured in step 1), piping the body via stdin.
     The worktree is clean after the review, so `open-pr` commits nothing new; it
     pushes the branch **once** — the only push of the flow, with hooks bypassed
     after explicit validation and review — and opens the PR. Capture its number
     and URL, and set `PR_NUMBER`. Stop if creation fails.
   - **A PR is already open** (the resume path from step 1): it is already pushed
     with the reviewed repairs; do **not** call `open-pr`. Reuse its number, URL,
     and title.

   Then confirm the pushed PR head and base are exactly the reviewed pair:

   ```bash
   test "$REVIEWED_SHA" = "$(git rev-parse HEAD)"
   PR_SHAS=$(gh pr view "$PR_NUMBER" --json headRefOid,baseRefOid -q '.headRefOid + " " + .baseRefOid' -R "$REPO")
   test "$PR_SHAS" = "$REVIEWED_SHA $REVIEWED_BASE_SHA"
   ```

   If either differs — `open-pr` committed a stray change, the head moved, or
   the base advanced — reconcile and re-review (step 2) before merging.

4. **Bring the branch up to date, then merge and clean up (bound to the
   reviewed head and base)** — never merge a branch that is behind its base or
   whose versions trail it. Before every merge attempt, run this **freshness
   gate**. It fetches the PR base branch's actual tip from GitHub — not only
   GitHub's PR snapshot, which can lag a push to the base — and proves that the
   reviewed head is the PR head, contains that exact tip, and carries the
   version bumps computed against it:

   ```bash
   BASE_BRANCH=$(gh pr view "$PR_NUMBER" --json baseRefName -q .baseRefName -R "$REPO")
   [ -n "$BASE_BRANCH" ] || { echo "Error: could not resolve the base branch of PR #$PR_NUMBER" >&2; exit 1; }
   git -c credential.helper= -c 'credential.helper=!gh auth git-credential' fetch --quiet "$BASE_URL" "$BASE_BRANCH" || { echo "Error: could not fetch $BASE_BRANCH from $BASE_URL" >&2; exit 1; }
   CURRENT_BASE_SHA=$(git rev-parse --verify 'FETCH_HEAD^{commit}') || { echo "Error: fetched base commit is unavailable" >&2; exit 1; }
   test "$REVIEWED_SHA" = "$(git rev-parse HEAD)" || { echo "Error: local HEAD moved off reviewed head $REVIEWED_SHA" >&2; exit 1; }
   test "$REVIEWED_SHA" = "$(gh pr view "$PR_NUMBER" --json headRefOid -q .headRefOid -R "$REPO")" || { echo "Error: PR #$PR_NUMBER head moved off reviewed head $REVIEWED_SHA; re-review required" >&2; exit 1; }
   BRANCH_CURRENT=false
   if [ "$CURRENT_BASE_SHA" = "$REVIEWED_BASE_SHA" ] &&
     [ "$(gh pr view "$PR_NUMBER" --json baseRefOid -q .baseRefOid -R "$REPO")" = "$REVIEWED_BASE_SHA" ] &&
     git merge-base --is-ancestor "$CURRENT_BASE_SHA" "$REVIEWED_SHA" &&
     "$BUN_BIN" --no-env-file --config=/dev/null "$AGENT_TOOL" checkVersions "$CURRENT_BASE_SHA"; then
     BRANCH_CURRENT=true
   fi
   ```

   Only exact equality with the fetched tip proves the review saw the base the
   PR will merge onto; ancestry proves the reviewed head contains it, and
   `checkVersions` proves that every changed versioned package at `HEAD` — the
   reviewed head — sits exactly one patch past it.

   - **`BRANCH_CURRENT=true`** — continue.
   - **`BRANCH_CURRENT=false`** — the base advanced (or was rewound) after the
     review, GitHub's PR snapshot has not caught up with it yet, or a version
     trails the base. Do not merge. Do not merge the base or bump a version
     here, and never push an unreviewed commit. With `--report-only`, stop
     with the PR open: report-only review skips base synchronization and
     version bumps, so it cannot produce a current head. Otherwise increment
     `BASE_REFRESH_ROUND` (starting from `0`) and **return to step 2**:
     `cross-agent-review`, invoked again with `--bump-versions` and the same
     agent, pass, and report-only arguments, now finds the PR open, so it
     merges the latest base, resolves version-only conflicts, re-bumps the
     versions past that base, pushes without force, and reviews the
     integrated head. Apply step 2's head checks and merge gate to the new
     `REVIEWED_SHA` and `REVIEWED_BASE_SHA`, then run this gate again. The
     refresh counter records work performed and never stops another required
     refresh. If `cross-agent-review` stops because the fetched base does not
     match GitHub's PR snapshot yet, GitHub is still catching up with the base
     push; retry shortly.

   A base refresh is not a repair round: it responds to external base
   movement, while repair rounds address reviewer findings. It still requires
   a complete re-review, because merging the base changes the candidate head
   and can change the PR diff.

   Once the gate passes, **wait for the PR's checks** on the reviewed head. A
   refresh pushes a new head, so CI runs again, and the guarded merge refuses
   anything short of GitHub's `CLEAN` merge state:

   ```bash
   gh pr checks "$PR_NUMBER" --watch --fail-fast -R "$REPO" || { echo "Error: checks did not pass on PR #$PR_NUMBER" >&2; exit 1; }
   ```

   In the seconds after a push, `gh` can report that no checks exist yet;
   re-run it rather than treating that as a failure. A failing check stops the
   flow with the PR open. Report it; a fix is a new change that goes back
   through `cross-agent-review`.

   CI takes minutes, and the base can move meanwhile. **Run the freshness gate
   again once the checks finish**, and merge only when it passes with the checks
   green on that same head. When it fails, refresh through step 2 as above and
   wait for the new head's checks.

   Then invoke the `squash-merge` compatibility skill, passing
   `REVIEWED_SHA` as its **second (head-SHA) argument** and
   `REVIEWED_BASE_SHA` as its **third (base-SHA) argument**. The guarded merge
   uses GitHub's merge API with `--match-head-commit`, after inspecting the
   effective branch policy and freshly confirming the reviewed base. GitHub's
   transaction rechecks the PR state, reviews, mergeability, policy, and exact
   head while merging. The base must enforce strict up-to-date checks so its
   policy guards base movement. The guarded path never arms delayed auto-merge.
   Pending requirements, unprotected bases, active merge queues, and weaker
   protected configurations stop safely.

   That skill also owns the post-merge cleanup: once GitHub confirms `MERGED`, it
   returns to the PR's base branch, fast-forwards it, verifies it contains the
   merge commit, and deletes the merged branch locally and remotely. Forward
   `--keep-branch` when it was given to opt out. Do not re-implement the cleanup
   here; it is gated on the merge actually landing, so it must stay with the step
   that performs the merge.

   **Invoke the `squash-merge` skill — do not call the tool directly from here.**
   The tool merges and returns; the cleanup and `--keep-branch` live in the skill
   *around* that call, and the tool knows neither. Reaching past the skill to
   `bun "$AGENT_TOOL" squashMerge …` merges the PR and silently skips the cleanup,
   leaving the feature branch checked out and undeleted.

   Because the head and base SHAs are the **second and third** positionals, pass
   an empty first argument to default the subject to the PR title:

   ```text
   squash-merge '' "$REVIEWED_SHA" "$REVIEWED_BASE_SHA"
   squash-merge '' "$REVIEWED_SHA" "$REVIEWED_BASE_SHA" --keep-branch
   ```

   The empty subject falls back to the PR title captured when the PR was opened
   or resumed (step 3, or step 1 on the resume path), to which the tool appends
   the `(#<pr>)` reference; it validates the subject with commitlint and
   confirms the PR reached `MERGED` before returning. Exit `2` means an
   auto-merge or queue entry is still pending after the bounded wait and may
   land later: do not clean up or report success, and monitor that PR before any
   retry. Other non-zero results mean the merge failed or the head moved off
   `REVIEWED_SHA`; do not report success, and re-review a changed head.

   When the merge fails with the PR still `OPEN` — including `squash-merge`
   reporting that the base moved — run the freshness gate once more. If it now
   fails, the base advanced between the gate and the merge: refresh through
   step 2 and repeat this step. If it still passes, the failure was something
   else; stop with the PR and checkout intact and report it. Never retry the
   merge with a stale pair, and never clean up after a failed merge.

5. **Reset the checkout** — invoke the `reset` skill with no arguments, but only
   when the merge landed and `--keep-branch` was **not** given. It puts the
   checkout on the repository default branch, fast-forwards it, and reinstalls
   the git hooks from `scripts/git/install-hooks.sh`.

   After step 4 the checkout is normally already on the base branch and current,
   so the branch half is a no-op; the hooks half is the point. This is where the
   flow re-bootstraps the hooks, including the pre-push commit-trust gate that
   refuses unsigned or co-authored commits on every manual push. Hook changes
   arrive as ordinary commits under `scripts/git/hooks/` and do nothing until
   they are copied into `.git/hooks`, so a flow that just merged one would
   otherwise leave the stale hook installed until someone noticed. Running the
   install *after* the fast-forward is what makes the freshly merged version the
   one installed.

   Skip it when `--keep-branch` was given — that flag exists to stay on the
   feature branch, and resetting would undo it — and when the merge did not land,
   since the branch and checkout must be left exactly as they are for the
   re-review. A `reset` failure does not invalidate the merge: report it and
   continue to step 6.

6. **Report results**: the PR URL, review agent and fallback status, repair rounds
   performed, base refreshes performed, findings fixed or waived, the version
   each changed package shipped at (for example
   `packages/client 0.1.4 → 0.1.5`, or that neither versioned package changed),
   and the final merge subject including its `(#<pr>)` reference. Note that
   the branch was pushed once, at open time (or, on the resume path, that it
   was already open). Confirm the merge reached
   `MERGED`, and state the branch returned to, that the merged branch was
   deleted, and that the hooks were reinstalled — or, when cleanup or the reset
   was skipped (`--keep-branch`, a dirty worktree, a merge that did not land),
   say so and what was left behind.

## Notes

- **Order is enforced**: commit → sync-bump-review-and-repair → open/resume →
  freshness gate → merge → cleanup → reset. A failure before the open step
  leaves committed local work and no PR; a failure after it leaves the PR in a
  safe, open state. Either way it is reported.
- **One push, after the review** — on the fresh path the branch is pushed exactly
  once, when the PR is opened, with feature-controlled hooks bypassed after the
  explicit gate. Reviewing local commits before the PR exists is what buys this
  — and the base merge the review does first stays local too while there is no
  PR, so it costs no extra push. (The resume path keeps its already-open PR and
  pushes repairs, and now the base merge, to it, as before.)
- **The review gates the merge** — this flow never silently merges over a verdict
  that reports unresolved blocking findings, and never merges an unreviewed head.
- **Repair belongs to `cross-agent-review`** — including the severity vocabulary
  (Blocker/Major ≡ [P0]/[P1] are blocking), and the re-review of every changed
  head. This skill only reads the verdict it reports and decides whether to
  merge. `--report-only` and `--passes` are forwarded, not interpreted.
- **The merged head and base are the reviewed pair** — `cross-agent-review`
  reports the exact head and base it reviewed. This skill re-verifies both once
  the PR is open and immediately before merge; `squash-merge` then binds GitHub's
  merge transaction to the exact reviewed head, while required strict
  protected-branch policy guards the freshly checked base. A detected head or
  base change therefore sends the flow back through sync and review.
  (A message-only
  co-author strip keeps it: step 3 checks tree and merge-base identity, then
  re-pins `REVIEWED_SHA`.) The lone exception
  is an explicit `--merge-anyway` over a could-not-run verdict, where the bound
  head is a candidate that no review read — the merge is still pinned, but the
  reviewed-head guarantee is the thing the caller chose to waive.
- **The branch is current when it merges.** The freshness gate compares the
  reviewed base with the base branch's fetched tip — not just GitHub's PR
  snapshot — before the checks wait and again right before the merge, and a
  merge that fails with the PR still open re-runs it. A stale branch goes back
  through `cross-agent-review`, which syncs, re-bumps, pushes, and re-reviews;
  no round count stops this. The required strict up-to-date policy closes the
  last race server-side: a head that no longer contains the base cannot merge.
- **Version bumps are serialized by base freshness.** Only a head that contains
  the latest base can merge, the review sync bumps each changed package to one
  past exactly that base, and `checkVersions` confirms it on the reviewed head
  just before the merge. Two PRs racing on the same package therefore land
  consecutive patch versions in merge order: the loser falls behind, syncs (any
  version-only conflict is resolved), bumps one past the winner, and is
  reviewed again. `packages/agent-tool`, `packages/ui`, and
  `packages/website` are not versioned by this flow.
- **Title and subject stay in sync automatically**: `squash-merge` defaults to
  the PR title that `open-pr` set, so a single title argument (or none) suffices
  for both.
- **Wrapped mechanics stay authoritative**: this skill coordinates, while
  `open-pr`, `cross-agent-review`, `squash-merge`, and `reset` retain ownership
  of their validation and external operations — including the post-merge cleanup,
  which lives in `squash-merge` because it must be gated on the merge landing.
- **Cleanup and reset are different steps.** `squash-merge` returns to the PR's
  *base* branch and deletes the merged branch, gated on the merge landing;
  `reset` then re-asserts the checkout on the *default* branch and reinstalls the
  hooks, knowing nothing about PRs and never deleting anything. The gated half
  cannot move into `reset` without losing its gate, which is why `reset` runs
  after rather than instead.
- **Cleanup never runs on an unmerged branch** — it is gated on GitHub reporting
  `MERGED` *and* on the base branch verifiably containing the merge commit, and
  it is skipped on a dirty worktree so in-progress work is never carried onto
  the base branch or stranded. In every case the branch survives and the reason
  is reported.
- **Invoke the wrapped skills, not the tools they call.** `squash-merge` is the
  clearest case: its cleanup and `--keep-branch` wrap the tool call rather than
  living inside the tool, so calling `squashMerge` directly still merges — it just
  skips the cleanup, and does so silently. The same holds for the review fallback
  chain and repair loop in `cross-agent-review`.
- Single-quote the title argument and use a quoted heredoc for the body (per
  `open-pr`) so the shell does not expand `$(...)`, backticks, or `$VAR`.
