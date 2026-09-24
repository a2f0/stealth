#!/usr/bin/env bash

set -euo pipefail

VERIFY_DOH_URL="${VERIFY_DOH_URL-https://cloudflare-dns.com/dns-query}"

for url in \
  "https://api-staging.tearleads.de/health" \
  "https://app-staging.tearleads.de" \
  "https://staging.tearleads.de"; do
  echo "Checking $url..."
  curl_args=(
    --connect-timeout 10
    --fail
    --max-time 30
    --retry 10
    --retry-all-errors
    --retry-delay 3
    --silent
    --show-error
    --output /dev/null
  )
  if [[ -n "$VERIFY_DOH_URL" ]]; then
    curl_args+=(--doh-url "$VERIFY_DOH_URL")
  fi
  curl "${curl_args[@]}" "$url"
done
echo "Staging URLs are reachable."
