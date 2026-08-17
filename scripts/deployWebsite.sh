#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=./cloudflareEnv.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/cloudflareEnv.sh"
load_cloudflare_env

export PUBLIC_APP_URL="${PUBLIC_APP_URL:-https://app.tearleads.com}"

echo "Building website with app URL $PUBLIC_APP_URL..."
if [[ "${DRY_RUN:-0}" == "1" ]]; then
  bun run --cwd "$REPO_ROOT/apps/website" build
  bunx wrangler deploy \
    --config "$REPO_ROOT/apps/website/wrangler.jsonc" \
    --dry-run
  exit 0
fi

echo "Deploying website Worker..."
bun run --cwd "$REPO_ROOT/apps/website" deploy
