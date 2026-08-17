#!/usr/bin/env bash

get_repo_root() {
  git rev-parse --show-toplevel
}

source_env_file() {
  local env_file="$1"

  if [[ ! -f "$env_file" ]]; then
    echo "ERROR: $env_file is missing." >&2
    echo "Create it or link .secrets to the shared Tearleads secret store." >&2
    return 1
  fi

  set -a
  # shellcheck source=/dev/null
  source "$env_file"
  set +a
}

load_cloudflare_env() {
  local secrets_dir
  secrets_dir="$(get_repo_root)/.secrets"
  source_env_file "$secrets_dir/root.env"
  validate_cloudflare_env

  export CLOUDFLARE_API_TOKEN="$TF_VAR_cloudflare_api_token"
  export CLOUDFLARE_ACCOUNT_ID="$TF_VAR_cloudflare_account_id"
}

validate_cloudflare_env() {
  local missing=()

  [[ -z "${TF_VAR_cloudflare_api_token:-}" ]] &&
    missing+=("TF_VAR_cloudflare_api_token")
  [[ -z "${TF_VAR_cloudflare_account_id:-}" ]] &&
    missing+=("TF_VAR_cloudflare_account_id")

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "ERROR: Missing required Cloudflare variables:" >&2
    printf '  - %s\n' "${missing[@]}" >&2
    return 1
  fi
}
