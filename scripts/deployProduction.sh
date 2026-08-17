#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"

echo "Running repository checks..."
bun run check
bun run test

"$SCRIPT_DIR/deployApi.sh"
"$SCRIPT_DIR/deployApp.sh"
"$SCRIPT_DIR/deployWebsite.sh"

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "Production deployment dry run completed successfully."
  exit 0
fi

"$SCRIPT_DIR/configureProductionDomains.sh"
"$SCRIPT_DIR/verifyProduction.sh"

echo "Production deployment completed successfully."
