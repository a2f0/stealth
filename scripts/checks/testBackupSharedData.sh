#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE="$(mktemp -d "$REPO_ROOT/.backup-test.XXXXXX")"
trap 'rm -rf "$FIXTURE"' EXIT
mkdir -p "$FIXTURE/source/.secrets" "$FIXTURE/output" "$FIXTURE/bin" "$FIXTURE/gnupg"
chmod 700 "$FIXTURE/gnupg"
printf 'fixture-secret\n' > "$FIXTURE/source/.secrets/fixture.env"
cat > "$FIXTURE/bin/git" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == 'rev-parse --show-toplevel' ]]; then
  printf '%s\n' "$MOCK_REPO_ROOT"
else
  exit 1
fi
EOF
chmod +x "$FIXTURE/bin/git"
export MOCK_REPO_ROOT="$FIXTURE/source" GNUPGHOME="$FIXTURE/gnupg"
BACKUP_SCRIPT="$REPO_ROOT/scripts/backupSharedData.sh"

if PATH="$FIXTURE/bin:$PATH" bash "$BACKUP_SCRIPT" "$FIXTURE/output" > "$FIXTURE/without-password.log" 2>&1; then
  echo 'Noninteractive backup succeeded without an encryption choice' >&2
  exit 1
fi
[[ -z "$(find "$FIXTURE/output" -type f -print)" ]]

PATH="$FIXTURE/bin:$PATH" bash "$BACKUP_SCRIPT" "$FIXTURE/output" --password fixture-passphrase > /dev/null
encrypted_archive="$(find "$FIXTURE/output" -name '*.zip.gpg' -print -quit)"
[[ -n "$encrypted_archive" && "$(stat -f '%Lp' "$encrypted_archive" 2>/dev/null || stat -c '%a' "$encrypted_archive")" == 600 ]]
gpg --batch --yes --pinentry-mode loopback --passphrase-fd 3 --decrypt "$encrypted_archive" \
  3<<<'fixture-passphrase' 2>/dev/null > "$FIXTURE/decrypted.zip"
[[ "$(unzip -p "$FIXTURE/decrypted.zip" .secrets/fixture.env)" == 'fixture-secret' ]]
if gpg --batch --yes --pinentry-mode loopback --passphrase-fd 3 --decrypt "$encrypted_archive" \
  3<<<'wrong-passphrase' >/dev/null 2>&1; then
  echo 'Encrypted backup accepted an incorrect passphrase' >&2
  exit 1
fi

PATH="$FIXTURE/bin:$PATH" bash "$BACKUP_SCRIPT" "$FIXTURE/output" --no-password > /dev/null
plain_archive="$(find "$FIXTURE/output" -name '*.zip' -print -quit)"
[[ -n "$plain_archive" && "$(stat -f '%Lp' "$plain_archive" 2>/dev/null || stat -c '%a' "$plain_archive")" == 600 ]]
[[ "$(unzip -p "$plain_archive" .secrets/fixture.env)" == 'fixture-secret' ]]

echo 'Shared data backup checks passed.'
