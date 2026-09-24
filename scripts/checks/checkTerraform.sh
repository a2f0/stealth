#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TERRAFORM_ROOT="$REPO_ROOT/terraform"

if ! command -v terraform >/dev/null 2>&1; then
  echo "ERROR: terraform is required for Terraform linting." >&2
  exit 1
fi

echo "Checking Terraform formatting..."
terraform -chdir="$TERRAFORM_ROOT" fmt -check -recursive -diff

if [[ "${TEARLEADS_PREFLIGHT_OFFLINE:-0}" == "1" ]]; then
  echo "Skipping provider-backed validation and TFLint in the network-isolated preflight."
  exit 0
fi

if ! command -v tflint >/dev/null 2>&1; then
  echo "ERROR: tflint is required for Terraform linting." >&2
  exit 1
fi

for tier in prod staging; do
  stack_dir="$TERRAFORM_ROOT/stacks/$tier"
  echo "Initializing $tier Terraform providers..."
  terraform -chdir="$stack_dir" init -backend=false -input=false >/dev/null
  terraform -chdir="$stack_dir" validate
  tflint --init --config="$REPO_ROOT/.tflint.hcl" --chdir="$stack_dir" >/dev/null
  tflint --config="$REPO_ROOT/.tflint.hcl" --chdir="$stack_dir"
done

echo "Terraform linting passed."
