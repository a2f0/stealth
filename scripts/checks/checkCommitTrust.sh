#!/usr/bin/env sh

set -eu

# Verifies that every commit in a range is (1) signed and (2) free of
# Co-authored-by trailers. Designed to be called from the pre-push hook with a
# computed rev-range, e.g. `checkCommitTrust.sh --range "$remote..$local"`.
# Unlike the reference version, more rev-list arguments may follow the range,
# e.g. `--range "$local" --not --remotes=origin` to check every commit a push
# adds to that remote, whichever local branch it was committed on.

usage() {
  echo "Usage: $0 --range <rev-range> [<rev-list argument>...]" >&2
  exit 2
}

case "${1:-}" in
  --range)
    shift
    [ "$#" -ge 1 ] || usage
    ;;
  --range=*)
    [ "$#" -eq 1 ] || usage
    set -- "${1#--range=}"
    ;;
  *)
    usage
    ;;
esac

[ -n "$1" ] || usage
range="$*"

# %G? is "N" when a commit carries no signature and "B" when it carries a bad
# (corrupt or forged) signature -- both are rejected. We accept G/U/E/X/Y/R so a
# signature that simply can't be verified locally (no public key on this machine
# -> "E") is allowed; we require a signature to be present and not provably bad,
# not that it be locally verifiable.
check_signed() {
  commit=$1
  sig=$(git show --no-patch --format="%G?" "$commit")

  if [ "$sig" = "N" ] || [ "$sig" = "B" ]; then
    echo "Error: commit $commit has a missing or invalid signature (status: $sig)." >&2
    echo "Sign it (e.g. 'git commit --amend -S' or rebase with --gpg-sign) before pushing." >&2
    echo "If it is signed, git could not read the signature: GPG signing needs gpg on PATH, and SSH signing needs gpg.ssh.allowedSignersFile." >&2
    return 1
  fi

  return 0
}

check_no_coauthors() {
  commit=$1
  coauthors=$(git show --no-patch --format="%(trailers:key=Co-authored-by,valueonly)" "$commit")

  if [ -n "$coauthors" ]; then
    echo "Error: commit $commit has a Co-authored-by trailer:" >&2
    printf '%s\n' "$coauthors" | sed 's/^/  /' >&2
    echo "" >&2
    echo "AGENT INSTRUCTION: Remove every Co-authored-by trailer from this commit's" >&2
    echo "message. Rewrite the offending commit(s) with 'git rebase -i <base>' (mark" >&2
    echo "them 'reword') or 'git commit --amend' for HEAD, deleting each" >&2
    echo "'Co-authored-by:' line. Do not add any Co-authored-by trailer in future" >&2
    echo "commits. Then re-run the push." >&2
    return 1
  fi

  return 0
}

failed=0

# Batch-scan the whole range in one git process: per commit, emit
# "<sha> <%G?> <co-author trailer values>". On the happy path (everything
# clean) this is the only git invocation; the detailed per-commit functions
# above only run for the few offenders. Assigning rather than iterating $(...)
# also lets a git failure (bad range, missing object) surface here instead of
# silently expanding to an empty list and passing the check.
if ! commit_info=$(git log --format="%H %G? %(trailers:key=Co-authored-by,valueonly,separator=%x2C)" "$@" --); then
  echo "Error: failed to list commits for range '$range'." >&2
  exit 1
fi

# A commit is an offender if its signature field is N/B, or if a third field
# (the trailer values) is present. %G? is always a single token, so the third
# field is unambiguously the co-author trailers.
unsigned=$(printf '%s\n' "$commit_info" | grep '^[^ ]* [NB] ' | cut -d' ' -f1)
coauthored=$(printf '%s\n' "$commit_info" | grep '^[^ ]* [^ ]* .' | cut -d' ' -f1)

for commit in $unsigned; do
  check_signed "$commit" || failed=1
done

for commit in $coauthored; do
  check_no_coauthors "$commit" || failed=1
done

[ "$failed" -eq 0 ] || exit 1
