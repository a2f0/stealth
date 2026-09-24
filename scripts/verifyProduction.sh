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

verify_url "API" "https://api.tearleads.de/health"

verify_auth_cors() {
  local method="$1"
  local headers
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
    --dump-header -
    --output /dev/null
    --header "Origin: https://app.tearleads.de"
  )

  if [[ -n "$VERIFY_DOH_URL" ]]; then
    curl_args+=(--doh-url "$VERIFY_DOH_URL")
  fi
  if [[ "$method" == "OPTIONS" ]]; then
    curl_args+=(
      --request OPTIONS
      --header "Access-Control-Request-Method: GET"
    )
  fi

  echo "Checking $method auth session CORS..."
  headers="$(curl "${curl_args[@]}" \
    "https://api.tearleads.de/api/auth/get-session")"
  headers="$(tr -d '\r' <<<"$headers" | tr '[:upper:]' '[:lower:]')"
  if [[ "$headers" != *$'\naccess-control-allow-origin: https://app.tearleads.de'$'\n'* ]] ||
    [[ "$headers" != *$'\naccess-control-allow-credentials: true'$'\n'* ]]; then
    echo "FAIL: $method auth session response lacks credentialed app CORS headers." >&2
    return 1
  fi
  echo "PASS: $method auth session allows credentialed requests from the app."
}

verify_auth_cors GET
verify_auth_cors OPTIONS
verify_url "app" "https://app.tearleads.de"
verify_url "website" "https://tearleads.de"
verify_url "privacy policy" "https://tearleads.de/privacy"
verify_url "terms of service" "https://tearleads.de/terms"
verify_url "data retention policy" "https://tearleads.de/data-retention"
