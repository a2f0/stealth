#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=./cloudflareEnv.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/cloudflareEnv.sh"
if [[ "${DEPLOY_TIER:-prod}" == "staging" ]]; then
  unset TF_VAR_cloudflare_api_token TF_VAR_cloudflare_account_id
  source_env_file "$(get_repo_root)/.secrets/staging.env"
  validate_cloudflare_env
  export CLOUDFLARE_API_TOKEN="${TF_VAR_cloudflare_api_token:-}"
  export CLOUDFLARE_ACCOUNT_ID="${TF_VAR_cloudflare_account_id:-}"
else
  load_cloudflare_env
fi

API_BASE="https://api.cloudflare.com/client/v4"
ZONE_NAME="tearleads.de"
DEPLOY_TIER="${DEPLOY_TIER:-prod}"
if [[ "$DEPLOY_TIER" != "prod" && "$DEPLOY_TIER" != "staging" ]]; then
  echo "ERROR: Unknown deployment tier: $DEPLOY_TIER" >&2
  exit 1
fi

cloudflare_get() {
  curl -fsS "$1" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
}

zone_response="$(
  cloudflare_get \
    "$API_BASE/zones?name=$ZONE_NAME&account.id=$CLOUDFLARE_ACCOUNT_ID"
)"
zone_id="$(jq -r '.result[0].id // empty' <<<"$zone_response")"

if [[ -z "$zone_id" ]]; then
  echo "ERROR: Cloudflare zone $ZONE_NAME was not found." >&2
  exit 1
fi

domains_response="$(
  cloudflare_get "$API_BASE/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/domains"
)"

check_hostname() {
  local hostname="$1"
  local expected_service="$2"
  local current_service
  local dns_response
  local conflicting_records

  current_service="$(
    jq -r --arg hostname "$hostname" \
      '.result[]? | select(.hostname == $hostname) | .service' \
      <<<"$domains_response"
  )"

  if [[ -n "$current_service" && "$current_service" != "$expected_service" ]]; then
    echo "ERROR: $hostname is attached to Worker $current_service." >&2
    return 1
  fi

  dns_response="$(
    curl -fsS --get "$API_BASE/zones/$zone_id/dns_records" \
      --data-urlencode "name=$hostname" \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
  )"
  conflicting_records="$(
    jq -r '[.result[]? | select(.type == "A" or .type == "AAAA" or .type == "CNAME")] | length' \
      <<<"$dns_response"
  )"

  if [[ "$conflicting_records" -gt 0 && "$current_service" != "$expected_service" ]]; then
    echo "ERROR: $hostname has an existing A, AAAA, or CNAME record." >&2
    return 1
  fi

  if [[ "$current_service" == "$expected_service" ]]; then
    echo "PASS: $hostname is already attached to $expected_service."
  else
    echo "PASS: $hostname is available for $expected_service."
  fi
}

if [[ "$DEPLOY_TIER" == "staging" ]]; then
  check_hostname "staging.tearleads.de" "tearleads-website-staging"
  check_hostname "app-staging.tearleads.de" "tearleads-client-staging"
  check_hostname "api-staging.tearleads.de" "tearleads-api-staging"
else
  check_hostname "tearleads.de" "tearleads-website"
  check_hostname "app.tearleads.de" "tearleads-client"
  check_hostname "api.tearleads.de" "tearleads-api"
fi
