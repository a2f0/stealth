#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REAL_BUN_BIN="$(command -v bun)"
export REAL_BUN_BIN
FIXTURE="$(mktemp -d)"
trap 'rm -rf "$FIXTURE"' EXIT

mkdir -p "$FIXTURE/scripts" "$FIXTURE/terraform/scripts" \
  "$FIXTURE/terraform/stacks/staging" "$FIXTURE/.secrets" "$FIXTURE/bin" \
  "$FIXTURE/apps/api" "$FIXTURE/apps/client" "$FIXTURE/apps/website"
cp "$REPO_ROOT/scripts/deployStaging.sh" "$REPO_ROOT/scripts/cloudflareEnv.sh" "$FIXTURE/scripts/"
cp "$REPO_ROOT/scripts/createStagingConfigs.ts" "$FIXTURE/scripts/"
cp "$REPO_ROOT/terraform/scripts/run.sh" "$FIXTURE/terraform/scripts/"
for target in api client website; do
  cp "$REPO_ROOT/apps/$target/wrangler.jsonc" "$FIXTURE/apps/$target/"
done
ln -s "$REPO_ROOT/node_modules" "$FIXTURE/node_modules"
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
if [[ "$1" == "scripts/createStagingConfigs.ts" ]]; then
  exec "$REAL_BUN_BIN" "$@"
fi
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

[[ "$(grep -c '^bunx wrangler deploy ' "$MOCK_LOG" || true)" -eq 3 ]] || {
  echo 'Expected three staging dry-run deployments' >&2
  exit 1
}
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

"$REAL_BUN_BIN" -e '
import { readFileSync } from "node:fs";
import { join } from "node:path";
const root = process.argv[1];
const read = (app) => JSON.parse(readFileSync(join(root, "apps", app, "wrangler.staging.jsonc"), "utf8"));
const api = read("api");
if (api.name !== "tearleads-api-staging") throw new Error("API Worker name is not staging");
if (api.vars.BETTER_AUTH_URL !== "https://api-staging.tearleads.de") throw new Error("API URL is not staging");
if (api.vars.CORS_ORIGIN !== "https://app-staging.tearleads.de") throw new Error("CORS origin is not staging");
if (api.vars.INBOUND_EMAIL_DOMAIN !== "inbox-staging.tearleads.de") throw new Error("Inbound email domain is not staging");
if (api.vars.PLAID_ENV !== "sandbox") throw new Error("Plaid environment is not sandbox");
if (api.d1_databases.length !== 1 || api.d1_databases[0].database_name !== "stealth-db-staging" || api.d1_databases[0].database_id !== "00000000-0000-4000-8000-000000000000") throw new Error("D1 binding is not staging");
if (api.r2_buckets.length !== 1 || api.r2_buckets[0].bucket_name !== "stealth-objects-staging") throw new Error("R2 binding is not staging");
if ("triggers" in api) throw new Error("Staging has production cron triggers");
if (read("client").name !== "tearleads-client-staging") throw new Error("Client Worker name is not staging");
if (read("website").name !== "tearleads-website-staging") throw new Error("Website Worker name is not staging");
' "$FIXTURE"

sed -i.bak 's/sk_test_fixture/sk_live_fixture/' "$FIXTURE/.secrets/staging.env"
: > "$MOCK_LOG"
if PATH="$FIXTURE/bin:$PATH" DRY_RUN=1 bash "$FIXTURE/scripts/deployStaging.sh" > "$FIXTURE/output.log" 2>&1; then
  echo 'Staging accepted a live Stripe key' >&2
  exit 1
fi
[[ ! -s "$MOCK_LOG" ]] || { echo 'Staging ran commands after rejecting a live Stripe key' >&2; exit 1; }

echo 'Staging deployment isolation checks passed.'
