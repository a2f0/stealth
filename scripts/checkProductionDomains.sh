#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=./cloudflareEnv.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/cloudflareEnv.sh"
load_cloudflare_env

API_BASE="https://api.cloudflare.com/client/v4"
ZONE_NAME="tearleads.com"

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

check_hostname "tearleads.com" "stealth-website"
check_hostname "app.tearleads.com" "stealth-client"
check_hostname "api.tearleads.com" "stealth-api"
