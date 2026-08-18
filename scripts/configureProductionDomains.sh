#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

"$SCRIPT_DIR/checkProductionDomains.sh"

apply_args=(apply -input=true)
if [[ "${AUTO_APPROVE:-0}" == "1" ]]; then
  apply_args=(apply -auto-approve)
fi

echo "Applying the production Worker custom domains with Terraform..."
bash "$REPO_ROOT/terraform/scripts/run.sh" "${apply_args[@]}"

"$SCRIPT_DIR/verifyInboundEmail.sh"
