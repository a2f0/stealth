#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EMAIL="${1:-}"
ROLE="${2:-}"
TARGET="${3:---remote}"

if [[ -z "$EMAIL" || -z "$ROLE" ]]; then
  echo "Usage: bun run auth:set-role <email> <user|admin> [--remote|--local]" >&2
  exit 1
fi

if [[ "$ROLE" != "user" && "$ROLE" != "admin" ]]; then
  echo "ERROR: Role must be either user or admin." >&2
  exit 1
fi

if [[ "$TARGET" != "--remote" && "$TARGET" != "--local" ]]; then
  echo "ERROR: Target must be either --remote or --local." >&2
  exit 1
fi

if [[ "$TARGET" == "--remote" ]]; then
  # shellcheck source=./cloudflareEnv.sh
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/cloudflareEnv.sh"
  load_cloudflare_env
fi

escaped_email="${EMAIL//\'/\'\'}"
sql="UPDATE \"user\" SET \"role\" = '$ROLE' WHERE \"email\" = '$escaped_email' RETURNING \"email\", \"role\";"

cd "$REPO_ROOT/apps/api"
result="$(
  bunx wrangler d1 execute stealth-db "$TARGET" --json --command "$sql"
)"

if ! jq -e --arg email "$EMAIL" --arg role "$ROLE" \
  'any(.. | objects; .email? == $email and .role? == $role)' \
  >/dev/null <<<"$result"; then
  echo "ERROR: No user with email $EMAIL was updated." >&2
  exit 1
fi

echo "Updated $EMAIL to the $ROLE role in ${TARGET#--} D1."
