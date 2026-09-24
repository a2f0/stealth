#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE="$(mktemp -d)"
trap 'rm -rf "$FIXTURE"' EXIT

mkdir -p "$FIXTURE/scripts" "$FIXTURE/terraform/scripts" \
  "$FIXTURE/terraform/stacks/staging" "$FIXTURE/.secrets" "$FIXTURE/bin"
cp "$REPO_ROOT/scripts/deployStaging.sh" "$REPO_ROOT/scripts/cloudflareEnv.sh" "$FIXTURE/scripts/"
cp "$REPO_ROOT/terraform/scripts/run.sh" "$FIXTURE/terraform/scripts/"
cat > "$FIXTURE/.secrets/staging.env" <<'EOF'
TF_VAR_cloudflare_api_token=test-token
TF_VAR_cloudflare_account_id=test-account
BETTER_AUTH_SECRET=test-auth
PLAID_CLIENT_ID=test-plaid-client
PLAID_SECRET=test-plaid-secret
PLAID_TOKEN_ENCRYPTION_KEY=test-plaid-encryption
STRIPE_SECRET_KEY=sk_test_fixture
STRIPE_WEBHOOK_SECRET=whsec_fixture
STAGING_STRIPE_PRO_PRICE_ID=price_fixture
EOF
cat > "$FIXTURE/bin/terraform" <<'EOF'
#!/usr/bin/env bash
printf 'terraform %s\n' "$*" >> "$MOCK_LOG"
if [[ "$*" == *' output -raw d1_database_id' ]]; then
  printf '00000000-0000-4000-8000-000000000000\n'
fi
EOF
cat > "$FIXTURE/bin/bun" <<'EOF'
#!/usr/bin/env bash
printf 'bun %s VITE_API_URL=%s VITE_WEBSITE_URL=%s PUBLIC_APP_URL=%s\n' \
  "$*" "${VITE_API_URL:-}" "${VITE_WEBSITE_URL:-}" "${PUBLIC_APP_URL:-}" >> "$MOCK_LOG"
EOF
cat > "$FIXTURE/bin/bunx" <<'EOF'
#!/usr/bin/env bash
printf 'bunx %s\n' "$*" >> "$MOCK_LOG"
EOF
chmod +x "$FIXTURE/bin/terraform" "$FIXTURE/bin/bun" "$FIXTURE/bin/bunx"

export MOCK_LOG="$FIXTURE/commands.log"
PATH="$FIXTURE/bin:$PATH" DRY_RUN=1 bash "$FIXTURE/scripts/deployStaging.sh" > "$FIXTURE/output.log"

mapfile -t deploys < <(grep '^bunx wrangler deploy ' "$MOCK_LOG")
[[ "${#deploys[@]}" -eq 3 ]] || { echo 'Expected three staging dry-run deployments' >&2; exit 1; }
for target in api client website; do
  [[ "$(grep -cF "wrangler deploy --config $FIXTURE/apps/$target/wrangler.staging.jsonc --dry-run" "$MOCK_LOG" || true)" == 1 ]] || {
    echo "Missing $target staging dry-run deployment" >&2
    exit 1
  }
done
[[ "$(cat "$MOCK_LOG")" == *'VITE_API_URL=https://api-staging.tearleads.de'* ]]
[[ "$(cat "$MOCK_LOG")" == *'VITE_WEBSITE_URL=https://staging.tearleads.de'* ]]
[[ "$(cat "$MOCK_LOG")" == *'PUBLIC_APP_URL=https://app-staging.tearleads.de'* ]]
if grep -Eq 'migrations apply|secret put|terraform .* apply|wrangler deploy .*wrangler\.jsonc' "$MOCK_LOG"; then
  echo 'Dry run attempted a remote mutation or production deployment' >&2
  exit 1
fi

sed -i.bak 's/sk_test_fixture/sk_live_fixture/' "$FIXTURE/.secrets/staging.env"
: > "$MOCK_LOG"
if PATH="$FIXTURE/bin:$PATH" DRY_RUN=1 bash "$FIXTURE/scripts/deployStaging.sh" > "$FIXTURE/output.log" 2>&1; then
  echo 'Staging accepted a live Stripe key' >&2
  exit 1
fi
[[ ! -s "$MOCK_LOG" ]] || { echo 'Staging ran commands after rejecting a live Stripe key' >&2; exit 1; }

echo 'Staging deployment isolation checks passed.'
