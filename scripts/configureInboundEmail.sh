#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=./cloudflareEnv.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/cloudflareEnv.sh"
load_cloudflare_email_env

API_BASE="https://api.cloudflare.com/client/v4"
ZONE_NAME="tearleads.com"

zone_response="$(
  curl -fsS "$API_BASE/zones?name=$ZONE_NAME" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
)"
zone_id="$(jq -r '.result[0].id // empty' <<<"$zone_response")"

if [[ -z "$zone_id" ]]; then
  echo "ERROR: Cloudflare zone $ZONE_NAME was not found." >&2
  exit 1
fi

settings_response="$(
  curl -fsS -X PATCH "$API_BASE/zones/$zone_id/email/routing" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H "Content-Type: application/json" \
    --data '{"support_subaddress":true}'
)"

if ! jq -e \
  '(.success == true) and (.result.support_subaddress == true)' \
  >/dev/null <<<"$settings_response"; then
  echo "ERROR: Could not enable Email Routing subaddressing." >&2
  jq -r '.errors[]?.message // empty' <<<"$settings_response" >&2
  exit 1
fi

echo "PASS: Cloudflare Email Routing subaddressing is enabled."
