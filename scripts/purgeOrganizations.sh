#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="--remote"
DRY_RUN=false

usage() {
  echo "Usage: bun run organizations:purge [--remote|--local] [--dry-run]" >&2
}

for argument in "$@"; do
  case "$argument" in
    --remote | --local)
      TARGET="$argument"
      ;;
    --dry-run)
      DRY_RUN=true
      ;;
    *)
      usage
      exit 1
      ;;
  esac
done

if [[ "$TARGET" == "--remote" ]]; then
  # shellcheck source=./cloudflareEnv.sh
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/cloudflareEnv.sh"
  load_cloudflare_env
fi

cd "$REPO_ROOT/apps/api"

eligible_sql='SELECT id, deletedAt FROM organization WHERE deletedAt IS NOT NULL AND datetime(deletedAt) <= datetime('"'"'now'"'"', '"'"'-30 days'"'"') ORDER BY deletedAt ASC, id ASC;'
eligible_json="$(
  bunx wrangler d1 execute stealth-db "$TARGET" --json \
    --command "$eligible_sql"
)"
eligible_rows="$(
  jq -r '
    [.. | objects |
      select((.id? | type) == "string" and
             (.deletedAt? | type) == "string")]
    | unique_by(.id)[]
    | [.id, .deletedAt]
    | @tsv
  ' <<<"$eligible_json"
)"

if [[ -z "$eligible_rows" ]]; then
  echo "No organizations are eligible for permanent deletion."
  exit 0
fi

purged_count=0
while IFS=$'\t' read -r organization_id deleted_at; do
  [[ -z "$organization_id" ]] && continue
  escaped_id="${organization_id//\'/\'\'}"
  object_sql="SELECT object_key FROM objects WHERE organization_id = '$escaped_id' ORDER BY object_key ASC;"
  object_json="$(
    bunx wrangler d1 execute stealth-db "$TARGET" --json \
      --command "$object_sql"
  )"
  object_keys="$(
    jq -r '.. | objects | .object_key? // empty' <<<"$object_json"
  )"

  echo "Organization $organization_id was deleted at $deleted_at."
  if [[ "$DRY_RUN" == "true" ]]; then
    object_count="$(grep -c . <<<"$object_keys" || true)"
    echo "Dry run: would delete $object_count R2 object(s) and the D1 organization."
    continue
  fi

  while IFS= read -r object_key; do
    [[ -z "$object_key" ]] && continue
    bunx wrangler r2 object delete "stealth-objects/$object_key" \
      "$TARGET" --force
  done <<<"$object_keys"

  delete_sql="DELETE FROM organization WHERE id = '$escaped_id' AND deletedAt IS NOT NULL AND datetime(deletedAt) <= datetime('now', '-30 days') RETURNING id, deletedAt;"
  deleted_json="$(
    bunx wrangler d1 execute stealth-db "$TARGET" --json \
      --command "$delete_sql"
  )"
  if ! jq -e --arg id "$organization_id" \
    'any(.. | objects; .id? == $id)' >/dev/null <<<"$deleted_json"; then
    echo "ERROR: Organization $organization_id was not deleted from D1." >&2
    exit 1
  fi
  purged_count=$((purged_count + 1))
  echo "Permanently deleted organization $organization_id."
done <<<"$eligible_rows"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "Dry run complete; no data was changed."
else
  echo "Permanently deleted $purged_count organization(s)."
fi
