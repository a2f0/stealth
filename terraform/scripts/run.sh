#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
STACK_DIR="$REPO_ROOT/terraform/stacks/prod"

# shellcheck source=../../scripts/cloudflareEnv.sh
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/cloudflareEnv.sh"

load_cloudflare_env

if [[ $# -eq 0 ]]; then
  set -- plan
fi

terraform -chdir="$STACK_DIR" init -input=false >/dev/null
exec terraform -chdir="$STACK_DIR" "$@"
