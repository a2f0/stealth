#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=./cloudflareEnv.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/cloudflareEnv.sh"
load_cloudflare_env

export VITE_API_URL="${VITE_API_URL:-https://api.tearleads.com}"

echo "Building app with API URL $VITE_API_URL..."
if [[ "${DRY_RUN:-0}" == "1" ]]; then
  bun run --cwd "$REPO_ROOT/apps/client" build
  bunx wrangler deploy \
    --config "$REPO_ROOT/apps/client/wrangler.jsonc" \
    --dry-run
  exit 0
fi

echo "Deploying app Worker..."
bun run --cwd "$REPO_ROOT/apps/client" deploy
