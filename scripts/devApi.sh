#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=./cloudflareEnv.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/cloudflareEnv.sh"
source_env_file "$REPO_ROOT/.secrets/root.env"
validate_auth_env

auth_env_file="$(mktemp)"
trap 'rm -f "$auth_env_file"' EXIT
chmod 600 "$auth_env_file"
printf '%s\n' \
  "BETTER_AUTH_SECRET=$BETTER_AUTH_SECRET" \
  "BETTER_AUTH_URL=http://localhost:8787" \
  "CORS_ORIGIN=http://localhost:5173" \
  >"$auth_env_file"

for secret_name in \
  PLAID_CLIENT_ID \
  PLAID_SECRET \
  PLAID_TOKEN_ENCRYPTION_KEY; do
  if [[ -n "${!secret_name:-}" ]]; then
    printf '%s=%s\n' "$secret_name" "${!secret_name}" >>"$auth_env_file"
  fi
done

cd "$REPO_ROOT/apps/api"
bunx wrangler dev --env-file "$auth_env_file"
