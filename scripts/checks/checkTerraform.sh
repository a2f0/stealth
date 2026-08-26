#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TERRAFORM_ROOT="$REPO_ROOT/terraform"
STACK_DIR="$TERRAFORM_ROOT/stacks/prod"

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

echo "Initializing Terraform providers..."
terraform -chdir="$STACK_DIR" init -backend=false -input=false >/dev/null

echo "Validating Terraform configuration..."
terraform -chdir="$STACK_DIR" validate

echo "Running TFLint..."
tflint --init --config="$REPO_ROOT/.tflint.hcl" --chdir="$STACK_DIR" >/dev/null
tflint --config="$REPO_ROOT/.tflint.hcl" --chdir="$STACK_DIR"

echo "Terraform linting passed."
