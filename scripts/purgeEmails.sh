#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="--remote"
DRY_RUN=false

usage() {
  echo "Usage: bun run emails:purge [--remote|--local] [--dry-run]" >&2
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

wrangler_storage_args=("$TARGET")
if [[ "$TARGET" == "--local" && -n "${STEALTH_WRANGLER_PERSIST_TO:-}" ]]; then
  wrangler_storage_args+=(--persist-to "$STEALTH_WRANGLER_PERSIST_TO")
fi

cd "$REPO_ROOT/apps/api"

eligible_sql='SELECT id, organization_id, deleted_at FROM inbound_emails WHERE deleted_at IS NOT NULL AND datetime(deleted_at) <= datetime('"'"'now'"'"', '"'"'-30 days'"'"') ORDER BY deleted_at ASC, id ASC;'
eligible_json="$(
  bunx wrangler d1 execute stealth-db "${wrangler_storage_args[@]}" --json \
    --command "$eligible_sql"
)"
eligible_rows="$(
  jq -r '
    [.. | objects |
      select((.id? | type) == "string" and
             (.organization_id? | type) == "string" and
             (.deleted_at? | type) == "string")]
    | unique_by(.id)[]
    | [.id, .organization_id, .deleted_at]
    | @tsv
  ' <<<"$eligible_json"
)"

if [[ -z "$eligible_rows" ]]; then
  echo "No emails are eligible for permanent deletion."
  exit 0
fi

purged_count=0
while IFS=$'\t' read -r email_id organization_id deleted_at; do
  [[ -z "$email_id" ]] && continue
  escaped_id="${email_id//\'/\'\'}"
  object_sql="SELECT raw_object_key AS object_key FROM inbound_emails WHERE id = '$escaped_id' AND deleted_at IS NOT NULL AND datetime(deleted_at) <= datetime('now', '-30 days') UNION SELECT attachment.object_key FROM inbound_email_attachments AS attachment JOIN inbound_emails AS email ON email.id = attachment.email_id WHERE email.id = '$escaped_id' AND email.deleted_at IS NOT NULL AND datetime(email.deleted_at) <= datetime('now', '-30 days') ORDER BY object_key ASC;"
  object_json="$(
    bunx wrangler d1 execute stealth-db "${wrangler_storage_args[@]}" --json \
      --command "$object_sql"
  )"
  object_keys="$(
    jq -r '.. | objects | .object_key? // empty' <<<"$object_json"
  )"

  if [[ -z "$object_keys" ]]; then
    echo "Skipped email $email_id because it is no longer eligible."
    continue
  fi

  echo "Email $email_id in organization $organization_id was deleted at $deleted_at."
  if [[ "$DRY_RUN" == "true" ]]; then
    object_count="$(grep -c . <<<"$object_keys" || true)"
    echo "Dry run: would delete $object_count R2 object(s) and the D1 email."
    continue
  fi

  while IFS= read -r object_key; do
    [[ -z "$object_key" ]] && continue
    bunx wrangler r2 object delete "stealth-objects/$object_key" \
      "${wrangler_storage_args[@]}" --force
  done <<<"$object_keys"

  delete_sql="DELETE FROM inbound_emails WHERE id = '$escaped_id' AND deleted_at IS NOT NULL AND datetime(deleted_at) <= datetime('now', '-30 days') RETURNING id, deleted_at;"
  deleted_json="$(
    bunx wrangler d1 execute stealth-db "${wrangler_storage_args[@]}" --json \
      --command "$delete_sql"
  )"
  if ! jq -e --arg id "$email_id" \
    'any(.. | objects; .id? == $id)' >/dev/null <<<"$deleted_json"; then
    echo "ERROR: Email $email_id was not deleted from D1." >&2
    exit 1
  fi
  purged_count=$((purged_count + 1))
  echo "Permanently deleted email $email_id."
done <<<"$eligible_rows"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "Dry run complete; no data was changed."
else
  echo "Permanently deleted $purged_count email(s)."
fi
