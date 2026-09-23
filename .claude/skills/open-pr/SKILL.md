---
name: open-pr
description: "Prepare a branch from the updated default branch when needed, then open a PR with a title that conforms to the repo's commitlint rules (e.g. fix(app): whatever)"
---

# Open PR

Prepare a pull-request branch and open its PR. When invoked on the repository's
default branch, first preserve the intended work, fast-forward the default
branch from the GitHub base repository, create a feature branch, and restore
the work there. The
PR **title must conform to the repository's commitlint rules**
(conventional-commit syntax and the 50-char header limit, e.g.
`fix(app): whatever`); it is validated before the PR is created.

## Arguments

- First argument (optional): the PR title. When omitted on an existing feature
  branch, the branch's latest commit subject is used. When starting with
  uncommitted work on the default branch, compose it from the task and reuse it
  for the primary commit and PR. Pass it as a single quoted argument.
- Branch name (optional): when starting on the default branch, use a supplied
  name or derive a concise `<type>/<kebab-slug>` name from the task or PR title.
- The PR body is read from stdin (empty when none is piped).

## Prerequisites

- `git`, `gh` (authenticated), POSIX `awk`, `realpath`, and `tar` on `PATH`.
- The `@tearleads/agent-tool` package in the fetched base commit. During the
  package's initial bootstrap PR only, set `TEARLEADS_AGENT_TOOL_DIR` to an
  independently trusted installation outside the repository checkout.
- `node_modules` installed (`bun install`) so repository checks and hooks run.
- Commit signing configured so `git commit -S` works without a prompt, and so
  git can verify the result (SSH signing also needs
  `gpg.ssh.allowedSignersFile`). Pushes
  are refused while any commit in the branch is unsigned.
- macOS Seatbelt for credential-free preflights. The tool fails closed instead
  of running branch scripts unsandboxed on another platform.
- The working tree contains only changes intended for this PR. Stop and ask
  before carrying unrelated changes onto a new branch or committing them.
- Before `openPr` runs, the feature branch must be pushed and have commits ahead
  of the base branch. The workflow below prepares this when necessary.
- No open PR already exists for the branch.

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
  tool_name=$1
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
DEFAULT_BRANCH=$(gh repo view "$REPO" --json defaultBranchRef -q .defaultBranchRef.name)
BASE_URL=$(gh repo view "$REPO" --json url -q .url)
[ -n "$REPO" ] || { echo "Error: repository identity is unavailable" >&2; exit 1; }
[ -n "$DEFAULT_BRANCH" ] || { echo "Error: repository default branch is unavailable" >&2; exit 1; }
[ -n "$BASE_URL" ] || { echo "Error: repository fetch URL is unavailable" >&2; exit 1; }

resolve_push_remote() {
  branch_name=$1
  for key in "branch.$branch_name.pushRemote" remote.pushDefault \
    "branch.$branch_name.remote"; do
    remote_name=$(git config --get "$key" || true)
    if [ -n "$remote_name" ] && [ "$remote_name" != "." ]; then
      printf '%s\n' "$remote_name"
      return
    fi
  done
  if git remote get-url origin >/dev/null 2>&1; then
    printf '%s\n' origin
  elif [ "$(git remote | wc -l | tr -d ' ')" = 1 ]; then
    git remote
  fi
}

PUSH_REMOTE=$(resolve_push_remote "$BRANCH")
[ -n "$PUSH_REMOTE" ] || { echo "Error: push remote is ambiguous" >&2; exit 1; }
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
    if git worktree list --porcelain | awk -v script="$trust_script" 'sub(/^worktree /, "") && (script == $0 || index(script, $0 "/") == 1) { found = 1 } END { exit !found }'; then
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

## Workflow

1. **Compose the title**: Write a conventional-commit title
   (`type(scope): description`, ≤50 chars). If the user supplied a title, use
   it. Otherwise, use the feature branch's latest commit subject when it
   describes the task; for uncommitted default-branch work, compose a title from
   the task before committing.

2. **Move default-branch work safely**: Skip this step when `$BRANCH` is already
   a feature branch. When `$BRANCH` equals `$DEFAULT_BRANCH`:

   - Derive or use a concise `<type>/<kebab-slug>` branch name, such as
     `fix/contacts-custom-org-loading`. Validate it before mutating Git state:

     ```bash
     git check-ref-format --branch "$NEW_BRANCH"
     if [ "${#NEW_BRANCH}" -gt 50 ]; then
       echo "Error: branch names must be 50 characters or fewer" >&2
       exit 1
     fi
     case "$NEW_BRANCH" in
       */*) ;;
       *) echo "Error: branch names must match <type>/<name>" >&2; exit 1 ;;
     esac
     BRANCH_TYPE=${NEW_BRANCH%%/*}
     BRANCH_NAME=${NEW_BRANCH#*/}
     case " build chore ci cleanup docs feat fix perf refactor revert style test " in
       *" $BRANCH_TYPE "*) ;;
       *) echo "Error: unsupported conventional branch type: $BRANCH_TYPE" >&2; exit 1 ;;
     esac
     case "$NEW_BRANCH" in
       *[!a-z0-9._/-]*) echo "Error: branch names must use lowercase letters, numbers, dots, dashes, underscores, and slashes" >&2; exit 1 ;;
     esac
     case "$BRANCH_NAME" in
       "" | [!a-z0-9]* | */ | */[!a-z0-9]*) echo "Error: every branch-name segment must begin with a lowercase letter or number" >&2; exit 1 ;;
     esac
     ```

   - Inspect `git status --short` and the diff. Continue only when every local
     change belongs in the requested PR.
   - Fetch first, verify that local default has no unique/diverged commits, and
     ensure the new branch name does not already exist locally or on the remote
     an ordinary push of that branch would use:

     ```bash
     FEATURE_REMOTE=$(resolve_push_remote "$NEW_BRANCH")
     [ -n "$FEATURE_REMOTE" ] || { echo "Error: feature push remote is ambiguous" >&2; exit 1; }
     if ! git merge-base --is-ancestor HEAD "$BASE_HEAD"; then
       echo "Error: local $DEFAULT_BRANCH has unique or diverged commits" >&2
       exit 1
     fi
     if git show-ref --verify --quiet "refs/heads/$NEW_BRANCH"; then
       echo "Error: branch already exists: $NEW_BRANCH" >&2
       exit 1
     fi
     REMOTE_BRANCH_STATUS=0
     git ls-remote --exit-code --heads "$FEATURE_REMOTE" "$NEW_BRANCH" >/dev/null || REMOTE_BRANCH_STATUS=$?
     case "$REMOTE_BRANCH_STATUS" in
       0) echo "Error: branch already exists: $NEW_BRANCH" >&2; exit 1 ;;
       2) ;;
       *) echo "Error: could not inspect $FEATURE_REMOTE for $NEW_BRANCH" >&2; exit 1 ;;
     esac
     ```

     If the ancestry check fails, stop rather than rebasing or resetting local
     default-branch commits.
   - If the tree is dirty, stash tracked, staged, and untracked work with a
     unique message, then record and verify the exact new stash OID. Ignored
     files are not carried. A failed stash must stop immediately; never resolve
     `stash@{0}` after failure because it may name unrelated older work:

     ```bash
     STASH_OID=""
     if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
       PREVIOUS_STASH_OID=$(git rev-parse --verify --quiet refs/stash || true)
       git -c core.hooksPath=/dev/null stash push --include-untracked -m "open-pr: move work to $NEW_BRANCH" || {
         echo "Error: could not stash work; branch transition was not attempted" >&2
         exit 1
       }
       STASH_OID=$(git rev-parse --verify --quiet refs/stash) || {
         echo "Error: the newly created stash could not be resolved" >&2
         exit 1
       }
       [ "$STASH_OID" != "$PREVIOUS_STASH_OID" ] || {
         echo "Error: stash did not create a new saved-work object" >&2
         exit 1
       }
     fi
     ```

   - Define one guarded restore path. It applies the exact saved OID first, then
     resolves and drops only that stash entry. Apply, resolution, and drop
     failures all leave the saved entry intact and stop the transition:

     ```bash
     restore_saved_work() {
       [ -n "$STASH_OID" ] || return 0
       git -c core.hooksPath=/dev/null stash apply --index "$STASH_OID" || {
         echo "Error: could not restore stash $STASH_OID; it was not dropped" >&2
         git status --short >&2
         return 1
       }
       STASH_REF=$(
         git stash list --format='%gd %H' |
           awk -v stash_oid="$STASH_OID" '$2 == stash_oid { print $1; exit }'
       )
       [ -n "$STASH_REF" ] || {
         echo "Error: restored stash OID is no longer in the stash list" >&2
         return 1
       }
       git -c core.hooksPath=/dev/null stash drop "$STASH_REF" || {
         echo "Error: restored work, but could not drop $STASH_REF" >&2
         return 1
       }
     }
     ```

   - Fast-forward the local default branch and create the new branch. Guard
     both mutations; if either fails after stashing, restore the exact saved
     work on the branch actually reached and stop:

     ```bash
     git -c core.hooksPath=/dev/null merge --ff-only "$BASE_HEAD" || {
       restore_saved_work
       exit 1
     }
     git -c core.hooksPath=/dev/null switch -c "$NEW_BRANCH" || {
       restore_saved_work
       exit 1
     }
     BRANCH=$(git branch --show-current) || {
       restore_saved_work
       exit 1
     }
     PUSH_REMOTE=$(resolve_push_remote "$BRANCH") || {
       restore_saved_work
       exit 1
     }
     [ "$PUSH_REMOTE" = "$FEATURE_REMOTE" ] || {
       echo "Error: feature push remote changed during branch creation" >&2
       restore_saved_work
       exit 1
     }
     ```

     Once the branch transition is verified, restore the saved index/worktree
     state. The helper drops the stash only after a successful apply:

     ```bash
     restore_saved_work || exit 1
     ```

     Drop only the resolved entry, and only after a successful apply. If apply
     conflicts or fails, leave the stash intact, report the new branch plus
     `git status`, and stop for resolution. Never use a hard reset, clean,
     forced branch creation, automatic rebase, or force push.

3. **Commit and push**: Run every branch-controlled package script through the
   trusted tool's credential-free, external-network-denied sandbox. Run the
   repository's primary preflight first, and invoke any additional relevant
   test or build script as another `runPreflight` action:

   ```bash
   "$BUN_BIN" --no-env-file --config=/dev/null "$AGENT_TOOL" runPreflight check
   ```

   Review the final diff, stage only intended paths, and commit any uncommitted
   work with a valid conventional subject — and never with a `Co-authored-by`
   trailer, which repository policy rejects. Contributor-controlled hooks stay
   disabled, and the commit is signed (`-S`), because unsigned commits are
   refused at push:

   ```bash
   git add <intended-paths>
   git -c core.hooksPath=/dev/null commit -S -m "$COMMIT_SUBJECT"
   ```

   Use separate commits for distinct changes when useful. Confirm the branch
   has commits ahead of `$BASE_HEAD`, then push without force to the resolved
   feature remote:

   ```bash
   verify_commit_trust "$BASE_HEAD" || exit 1
   git push --no-verify -u "$PUSH_REMOTE" "$BRANCH"
   ```

   `--no-verify` is required here: feature-controlled hooks must not run with
   ambient GitHub or reviewer credentials. The sandboxed preflight above is the
   validation gate: it strips credentials, denies external network access, and
   prevents writes to `.git` and `node_modules`. Skipping the hook also skips
   its commit-trust check, so `verify_commit_trust` runs that check first from
   the trusted base and refuses the push if any commit is unsigned or carries a
   `Co-authored-by` trailer. Inspect commit messages for forbidden co-author
   trailers before the review; never rewrite the reviewed head during this push
   step. Re-signing changes a commit's SHA, so a reviewed head that fails the
   check goes back through review after it is fixed.

4. **Open the PR** (title single-quoted; body via a quoted heredoc):

   ```bash
   "$BUN_BIN" --no-env-file --config=/dev/null "$AGENT_TOOL" openPr 'feat(app): add widget' <<'EOF'
   ## Summary
   What changed and why.
   EOF
   ```

   To default the title to the latest commit subject, or to open with no body:

   ```bash
   "$BUN_BIN" --no-env-file --config=/dev/null "$AGENT_TOOL" openPr </dev/null
   ```

   **Quote the title in single quotes** and use a **quoted heredoc** (`<<'EOF'`)
   for the body so the shell does not expand `$(...)`, backticks, or `$VAR`
   before the tool sees them.

   The tool:
   - Resolves the current branch and repo, and errors if an open PR already
     exists for the branch.
   - Rejects a multi-line title.
   - Validates the title with the trusted tool snapshot's side-effect-free copy
     of the repository's commitlint header policy. It never loads the feature
     checkout's executable `commitlint.config.mts`. If validation fails it
     prints the policy report and exits non-zero **without creating the PR**.
   - Rejects a body carrying Claude Code branding — the "Generated with Claude
     Code" attribution, its `claude.com/claude-code` or `claude.ai/code` links,
     or a Claude co-author trailer — and exits non-zero **without creating the
     PR**. This mirrors the repository's ban on co-author trailers: keep the
     attribution footer out of PR descriptions entirely.
   - Resolves the branch's push repository and creates the PR with an explicit
     owner-qualified head (`owner:branch`). The base defaults to the repository's
     default branch; the qualified head prevents a same-named fork from being
     selected. Prints the PR URL.

5. **On a validation failure**: for a rejected title, relay commitlint's output,
   propose a corrected title (valid type, ≤50 chars), and re-run once confirmed.
   For a rejected body, remove the flagged Claude Code branding from the
   description and re-run — never re-add the attribution to satisfy it.

6. **Report results**: output the created PR URL and the final title.

## Notes

- The title obeys the same commitlint rules as commits, so it can later be
  reused verbatim as the squash-merge subject.
- Always single-quote the title and use a quoted heredoc for the body.
- Default-branch preparation carries untracked files but not ignored files.
- Never commit unrelated user changes or discard a stash after a failed restore.
- The body must not contain Claude Code branding; the tool rejects it before
  creating the PR, so write PR descriptions without any attribution footer.
- Base defaults to the repository's default branch.
