#!/usr/bin/env bash

set -euo pipefail

VERIFY_DOH_URL="${VERIFY_DOH_URL-https://cloudflare-dns.com/dns-query}"

verify_url() {
  local label="$1"
  local url="$2"
  local curl_args=(
    --connect-timeout 10
    --fail
    --max-time 30
    --silent
    --show-error
    --retry 10
    --retry-all-errors
    --retry-delay 3
    --retry-max-time 120
    --output /dev/null
  )

  # Fresh custom domains can be negatively cached by the local resolver even
  # after Cloudflare's public DNS serves them. An empty value disables DoH.
  if [[ -n "$VERIFY_DOH_URL" ]]; then
    curl_args+=(--doh-url "$VERIFY_DOH_URL")
  fi

  echo "Checking $label at $url..."
  curl "${curl_args[@]}" "$url"
  echo "PASS: $label is reachable."
}

verify_url "API" "https://api.tearleads.com/health"
verify_url "app" "https://app.tearleads.com"
verify_url "website" "https://tearleads.com"
