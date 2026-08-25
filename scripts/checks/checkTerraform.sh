#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TERRAFORM_ROOT="$REPO_ROOT/terraform"
STACK_DIR="$TERRAFORM_ROOT/stacks/prod"

for command in terraform tflint; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "ERROR: $command is required for Terraform linting." >&2
    exit 1
  fi
done

echo "Checking Terraform formatting..."
terraform -chdir="$TERRAFORM_ROOT" fmt -check -recursive -diff

echo "Initializing Terraform providers..."
if [[ "${TEARLEADS_PREFLIGHT_OFFLINE:-0}" == "1" ]]; then
  if [[ ! -d "$STACK_DIR/.terraform/providers" ]]; then
    echo "ERROR: Terraform providers must be installed before an offline preflight." >&2
    exit 1
  fi
  echo "Using the installed provider cache for the offline preflight."
else
  terraform -chdir="$STACK_DIR" init -backend=false -input=false >/dev/null
fi

echo "Validating Terraform configuration..."
terraform -chdir="$STACK_DIR" validate

echo "Running TFLint..."
tflint --init --config="$REPO_ROOT/.tflint.hcl" --chdir="$STACK_DIR" >/dev/null
tflint --config="$REPO_ROOT/.tflint.hcl" --chdir="$STACK_DIR"

echo "Terraform linting passed."
