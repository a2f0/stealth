#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=./cloudflareEnv.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/cloudflareEnv.sh"
DEPLOY_TIER="${DEPLOY_TIER:-prod}"
if [[ "$DEPLOY_TIER" == "staging" ]]; then
  unset TF_VAR_cloudflare_api_token TF_VAR_cloudflare_account_id \
    CLOUDFLARE_EMAIL_API_TOKEN
  source_env_file "$(get_repo_root)/.secrets/staging.env"
  validate_cloudflare_env
  if [[ -z "${CLOUDFLARE_EMAIL_API_TOKEN:-}" ]]; then
    echo "ERROR: Missing CLOUDFLARE_EMAIL_API_TOKEN." >&2
    exit 1
  fi
  export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_EMAIL_API_TOKEN"
elif [[ "$DEPLOY_TIER" == "prod" ]]; then
  load_cloudflare_email_env
else
  echo "ERROR: Unknown deployment tier: $DEPLOY_TIER" >&2
  exit 1
fi

API_BASE="https://api.cloudflare.com/client/v4"
ZONE_NAME="tearleads.de"
if [[ "$DEPLOY_TIER" == "staging" ]]; then
  INBOUND_DOMAIN="inbox-staging.tearleads.de"
  INBOUND_ADDRESS="upload@inbox-staging.tearleads.de"
  WORKER_NAME="tearleads-api-staging"
else
  INBOUND_DOMAIN="inbox.tearleads.de"
  INBOUND_ADDRESS="upload@inbox.tearleads.de"
  WORKER_NAME="tearleads-api"
fi

cloudflare_get() {
  curl -fsS "$1" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
}

zone_response="$(cloudflare_get "$API_BASE/zones?name=$ZONE_NAME")"
zone_id="$(jq -r '.result[0].id // empty' <<<"$zone_response")"

if [[ -z "$zone_id" ]]; then
  echo "ERROR: Cloudflare zone $ZONE_NAME was not found." >&2
  exit 1
fi

# The Email Routing DNS endpoint only describes the records a subdomain needs,
# and public resolvers negatively cache a subdomain that was checked before it
# existed, so read the zone's live MX records with the account token.
if [[ "$DEPLOY_TIER" == "staging" ]]; then
  export CLOUDFLARE_API_TOKEN="${TF_VAR_cloudflare_api_token:-}"
  export CLOUDFLARE_ACCOUNT_ID="${TF_VAR_cloudflare_account_id:-}"
else
  load_cloudflare_env
fi
mx_response="$(
  curl -fsS --get "$API_BASE/zones/$zone_id/dns_records" \
    --data-urlencode "type=MX" \
    --data-urlencode "name=$INBOUND_DOMAIN" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
)"
if [[ "$DEPLOY_TIER" == "staging" ]]; then
  export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_EMAIL_API_TOKEN"
else
  load_cloudflare_email_env
fi

if ! jq -e \
  '(.success == true) and
   (([.result[]? |
      select(.content | test("mx\\.cloudflare\\.net\\.?$"))] |
     length) == 3)' \
  >/dev/null <<<"$mx_response"; then
  echo "ERROR: Email Routing MX records are not live for $INBOUND_DOMAIN." >&2
  exit 1
fi

rules_response="$(
  cloudflare_get "$API_BASE/zones/$zone_id/email/routing/rules"
)"

matching_rules="$(
  jq --arg address "$INBOUND_ADDRESS" --arg worker "$WORKER_NAME" \
    '[.result[]? |
      select(.enabled == true) |
      select(any(.matchers[]?;
        .type == "literal" and .field == "to" and .value == $address)) |
      select(any(.actions[]?;
        .type == "worker" and any(.value[]?; . == $worker)))] |
     length' \
    <<<"$rules_response"
)"

if [[ "$matching_rules" -ne 1 ]]; then
  echo "ERROR: Expected one active route from $INBOUND_ADDRESS to $WORKER_NAME." >&2
  exit 1
fi

settings_response="$(cloudflare_get "$API_BASE/zones/$zone_id/email/routing")"
if ! jq -e \
  '(.success == true) and (.result.support_subaddress == true)' \
  >/dev/null <<<"$settings_response"; then
  echo "ERROR: Email Routing subaddressing is not enabled." >&2
  exit 1
fi

echo "PASS: $INBOUND_DOMAIN has its three Cloudflare Email Routing MX records."
echo "PASS: $INBOUND_ADDRESS routes organization subaddresses to $WORKER_NAME."
