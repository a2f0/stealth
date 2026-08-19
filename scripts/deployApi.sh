#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=./cloudflareEnv.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/cloudflareEnv.sh"
load_cloudflare_env
validate_auth_env
validate_plaid_env

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "Dry-running API Worker deployment..."
  bunx wrangler deploy \
    --config "$REPO_ROOT/apps/api/wrangler.jsonc" \
    --dry-run
  exit 0
fi

echo "Applying production D1 migrations..."
bun run --cwd "$REPO_ROOT/apps/api" db:migrate:remote

echo "Updating the Better Auth Worker secret..."
printf '%s' "$BETTER_AUTH_SECRET" | bunx wrangler secret put \
  BETTER_AUTH_SECRET \
  --config "$REPO_ROOT/apps/api/wrangler.jsonc" \
  >/dev/null

echo "Updating Plaid Worker secrets..."
for secret_name in \
  PLAID_CLIENT_ID \
  PLAID_SECRET \
  PLAID_TOKEN_ENCRYPTION_KEY; do
  printf '%s' "${!secret_name}" | bunx wrangler secret put \
    "$secret_name" \
    --config "$REPO_ROOT/apps/api/wrangler.jsonc" \
    >/dev/null
done

echo "Deploying API Worker..."
bun run --cwd "$REPO_ROOT/apps/api" deploy
