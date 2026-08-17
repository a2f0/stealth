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
terraform -chdir="$STACK_DIR" init -backend=false -input=false >/dev/null

echo "Validating Terraform configuration..."
terraform -chdir="$STACK_DIR" validate

echo "Running TFLint..."
tflint --init --config="$REPO_ROOT/.tflint.hcl" --chdir="$STACK_DIR" >/dev/null
tflint --config="$REPO_ROOT/.tflint.hcl" --chdir="$STACK_DIR"

echo "Terraform linting passed."
