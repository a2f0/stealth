#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=./cloudflareEnv.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/cloudflareEnv.sh"
source_env_file "$REPO_ROOT/.secrets/root.env"
validate_auth_env
if [[ -n "${STRIPE_SECRET_KEY:-}" ||
  -n "${STRIPE_WEBHOOK_SECRET:-}" ||
  -n "${STRIPE_PRO_PRICE_ID:-}" ||
  -n "${STRIPE_PORTAL_CONFIGURATION_ID:-}" ||
  -n "${STRIPE_PRO_LEGACY_PRICE_IDS:-}" ]]; then
  validate_stripe_env
  if [[ -z "${STRIPE_PRO_PRICE_ID:-}" ]]; then
    echo "ERROR: Missing STRIPE_PRO_PRICE_ID for local billing." >&2
    exit 1
  fi
fi

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
  PLAID_TOKEN_ENCRYPTION_KEY \
  STRIPE_SECRET_KEY \
  STRIPE_WEBHOOK_SECRET; do
  if [[ -n "${!secret_name:-}" ]]; then
    printf '%s=%s\n' "$secret_name" "${!secret_name}" >>"$auth_env_file"
  fi
done

if [[ -f "$REPO_ROOT/.secrets/staging.env" ]]; then
  (
    unset CHECKR_API_KEY CHECKR_BACKGROUND_PACKAGE CHECKR_CREDIT_PACKAGE
    source_env_file "$REPO_ROOT/.secrets/staging.env"
    for secret_name in \
      CHECKR_API_KEY CHECKR_BACKGROUND_PACKAGE CHECKR_CREDIT_PACKAGE; do
      if [[ -n "${!secret_name:-}" ]]; then
        printf '%s=%s\n' "$secret_name" "${!secret_name}" >>"$auth_env_file"
      fi
    done
  )
fi

cd "$REPO_ROOT/apps/api"
bunx wrangler dev \
  --env-file "$auth_env_file" \
  --var "CHECKR_ENV:staging" \
  --var "STRIPE_PRO_LEGACY_PRICE_IDS:${STRIPE_PRO_LEGACY_PRICE_IDS:-}" \
  --var "STRIPE_PRO_PRICE_ID:${STRIPE_PRO_PRICE_ID:-}" \
  --var "STRIPE_PORTAL_CONFIGURATION_ID:${STRIPE_PORTAL_CONFIGURATION_ID:-}"
