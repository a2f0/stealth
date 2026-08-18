#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=./cloudflareEnv.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/cloudflareEnv.sh"
load_cloudflare_email_env

API_BASE="https://api.cloudflare.com/client/v4"
ZONE_NAME="tearleads.com"
INBOUND_DOMAIN="inbox.tearleads.com"
INBOUND_ADDRESS="upload@inbox.tearleads.com"
WORKER_NAME="stealth-api"

cloudflare_get() {
  curl -fsS "$1" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
}

zone_response="$(cloudflare_get "$API_BASE/zones?name=$ZONE_NAME")"
zone_id="$(jq -r '.result[0].id // empty' <<<"$zone_response")"

if [[ -z "$zone_id" ]]; then
  echo "ERROR: Cloudflare zone $ZONE_NAME was not found." >&2
  exit 1
fi

dns_response="$(
  curl -fsS --get "$API_BASE/zones/$zone_id/email/routing/dns" \
    --data-urlencode "subdomain=$INBOUND_DOMAIN" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
)"

if ! jq -e \
  '(.success == true) and
   (((.result.errors // []) | length) == 0) and
   (([((.result.records // .result.record) // [])[]? |
      select(.type == "MX" and
        (.content | test("mx\\.cloudflare\\.net\\.?$")))] |
     length) == 3)' \
  >/dev/null <<<"$dns_response"; then
  echo "ERROR: Email Routing MX records are not ready for $INBOUND_DOMAIN." >&2
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

echo "PASS: $INBOUND_DOMAIN has its three Cloudflare Email Routing MX records."
echo "PASS: $INBOUND_ADDRESS routes to the $WORKER_NAME email handler."
