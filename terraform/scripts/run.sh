#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TIER="${1:-prod}"
if [[ "$TIER" == "staging" || "$TIER" == "prod" ]]; then
  shift
else
  TIER="prod"
fi
STACK_DIR="$REPO_ROOT/terraform/stacks/$TIER"

# shellcheck source=../../scripts/cloudflareEnv.sh
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/cloudflareEnv.sh"

if [[ "$TIER" == "staging" ]]; then
  unset TF_VAR_cloudflare_api_token TF_VAR_cloudflare_account_id
  source_env_file "$REPO_ROOT/.secrets/staging.env"
  validate_cloudflare_env
else
  load_cloudflare_env
fi

if [[ $# -eq 0 ]]; then
  set -- plan
fi

terraform -chdir="$STACK_DIR" init -input=false >/dev/null
exec terraform -chdir="$STACK_DIR" "$@"
