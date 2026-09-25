#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=./cloudflareEnv.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/cloudflareEnv.sh"
unset TF_VAR_cloudflare_api_token TF_VAR_cloudflare_account_id
unset BETTER_AUTH_SECRET PLAID_CLIENT_ID PLAID_SECRET \
  CHECKR_API_KEY CHECKR_BACKGROUND_PACKAGE CHECKR_CREDIT_PACKAGE \
  PLAID_TOKEN_ENCRYPTION_KEY STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET \
  STAGING_STRIPE_PRO_PRICE_ID STAGING_STRIPE_PORTAL_CONFIGURATION_ID
source_env_file "$REPO_ROOT/.secrets/staging.env"
validate_cloudflare_env
validate_auth_env
validate_plaid_env
validate_stripe_env

if [[ "$STRIPE_SECRET_KEY" != sk_test_* && "$STRIPE_SECRET_KEY" != rk_test_* ]]; then
  echo "ERROR: Staging requires a Stripe test-mode secret key." >&2
  exit 1
fi
if [[ "${STAGING_STRIPE_PRO_PRICE_ID:-}" != price_* ]]; then
  echo "ERROR: STAGING_STRIPE_PRO_PRICE_ID must be a Stripe price ID." >&2
  exit 1
fi

export CLOUDFLARE_API_TOKEN="${TF_VAR_cloudflare_api_token:-}"
export CLOUDFLARE_ACCOUNT_ID="${TF_VAR_cloudflare_account_id:-}"
STAGING_D1_DATABASE_ID="$(
  bash "$REPO_ROOT/terraform/scripts/run.sh" staging output -raw d1_database_id
)"
STAGING_D1_DATABASE_NAME="$(
  bash "$REPO_ROOT/terraform/scripts/run.sh" staging output -raw d1_database_name
)"
STAGING_R2_BUCKET_NAME="$(
  bash "$REPO_ROOT/terraform/scripts/run.sh" staging output -raw r2_bucket_name
)"
export STAGING_D1_DATABASE_ID STAGING_D1_DATABASE_NAME STAGING_R2_BUCKET_NAME
if [[ ! "$STAGING_D1_DATABASE_ID" =~ ^[0-9a-fA-F-]{36}$ ]]; then
  echo "ERROR: Staging Terraform has no valid D1 database ID." >&2
  exit 1
fi
if [[ -z "$STAGING_D1_DATABASE_NAME" || -z "$STAGING_R2_BUCKET_NAME" ]]; then
  echo "ERROR: Staging Terraform has no D1 database or R2 bucket name." >&2
  exit 1
fi

cd "$REPO_ROOT"
echo "Running repository checks..."
bun run check
bun run test
bun scripts/createStagingConfigs.ts

api_config="$REPO_ROOT/packages/api/wrangler.staging.jsonc"
client_config="$REPO_ROOT/packages/client/wrangler.staging.jsonc"
website_config="$REPO_ROOT/packages/website/wrangler.staging.jsonc"

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  bunx wrangler deploy --config "$api_config" --dry-run
else
  bunx wrangler d1 migrations apply DB --remote --config "$api_config"
  for secret_name in \
    BETTER_AUTH_SECRET PLAID_CLIENT_ID PLAID_SECRET \
    PLAID_TOKEN_ENCRYPTION_KEY STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET; do
    printf '%s' "${!secret_name}" | bunx wrangler secret put \
      "$secret_name" --config "$api_config" >/dev/null
  done
  for secret_name in \
    CHECKR_API_KEY CHECKR_BACKGROUND_PACKAGE CHECKR_CREDIT_PACKAGE; do
    if [[ -n "${!secret_name:-}" ]]; then
      printf '%s' "${!secret_name}" | bunx wrangler secret put \
        "$secret_name" --config "$api_config" >/dev/null
    fi
  done
  bunx wrangler deploy --config "$api_config"
fi

VITE_API_URL="https://api-staging.tearleads.de" \
  VITE_WEBSITE_URL="https://staging.tearleads.de" \
  bun run --cwd "$REPO_ROOT/packages/client" build
PUBLIC_APP_URL="https://app-staging.tearleads.de" \
  bun run --cwd "$REPO_ROOT/packages/website" build

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  bunx wrangler deploy --config "$client_config" --dry-run
  bunx wrangler deploy --config "$website_config" --dry-run
  echo "Staging dry run completed."
  exit 0
fi

bunx wrangler deploy --config "$client_config"
bunx wrangler deploy --config "$website_config"
DEPLOY_TIER=staging bash "$SCRIPT_DIR/checkProductionDomains.sh"
apply_args=(apply -input=true)
if [[ "${AUTO_APPROVE:-0}" == "1" ]]; then
  apply_args=(apply -auto-approve)
fi
bash "$REPO_ROOT/terraform/scripts/run.sh" staging "${apply_args[@]}"
bash "$SCRIPT_DIR/verifyStaging.sh"
DEPLOY_TIER=staging bash "$SCRIPT_DIR/verifyInboundEmail.sh"
echo "Staging deployment completed."
