#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="--remote"
DRY_RUN=false
BUCKET="stealth-objects"

usage() {
  echo "Usage: bun run organizations:objects:reorganize [--remote|--local] [--dry-run]" >&2
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

legacy_sql="
SELECT 'upload' AS record_type, id AS record_id, organization_id,
       object_key, content_type
FROM objects
WHERE substr(object_key, 1, length('organizations/' || organization_id || '/'))
      != 'organizations/' || organization_id || '/'
UNION ALL
SELECT 'inbound_email' AS record_type, id AS record_id, organization_id,
       raw_object_key AS object_key, 'message/rfc822' AS content_type
FROM inbound_emails
WHERE substr(raw_object_key, 1,
             length('organizations/' || organization_id || '/'))
      != 'organizations/' || organization_id || '/'
UNION ALL
SELECT 'inbound_attachment' AS record_type, attachment.id AS record_id,
       email.organization_id, attachment.object_key, attachment.content_type
FROM inbound_email_attachments AS attachment
JOIN inbound_emails AS email ON email.id = attachment.email_id
WHERE substr(attachment.object_key, 1,
             length('organizations/' || email.organization_id || '/'))
      != 'organizations/' || email.organization_id || '/'
ORDER BY organization_id, record_type, record_id;
"

legacy_json="$(
  bunx wrangler d1 execute stealth-db "${wrangler_storage_args[@]}" --json \
    --command "$legacy_sql"
)"
legacy_rows="$(
  jq -c '
    [.. | objects |
      select((.record_type? | type) == "string" and
             (.record_id? | type) == "string" and
             (.organization_id? | type) == "string" and
             (.object_key? | type) == "string")]
    | unique_by([.record_type, .record_id])
    | sort_by([.organization_id, .record_type, .record_id])[]
  ' <<<"$legacy_json"
)"

if [[ -z "$legacy_rows" ]]; then
  echo "All D1-backed R2 objects already use organization prefixes."
  exit 0
fi

legacy_count="$(grep -c . <<<"$legacy_rows" || true)"
if [[ "$DRY_RUN" == "true" ]]; then
  echo "Dry run: $legacy_count R2 object(s) need organization prefixes."
else
  echo "Moving $legacy_count R2 object(s) into organization prefixes."
fi

temporary_directory=""
cleanup() {
  if [[ -n "$temporary_directory" ]]; then
    rm -rf -- "$temporary_directory"
  fi
}
trap cleanup EXIT

if [[ "$DRY_RUN" == "false" ]]; then
  temporary_directory="$(mktemp -d)"
fi

sql_escape() {
  local value="$1"
  printf '%s' "${value//\'/\'\'}"
}

moved_count=0
while IFS= read -r row; do
  [[ -z "$row" ]] && continue
  record_type="$(jq -r '.record_type' <<<"$row")"
  record_id="$(jq -r '.record_id' <<<"$row")"
  organization_id="$(jq -r '.organization_id' <<<"$row")"
  old_key="$(jq -r '.object_key' <<<"$row")"
  content_type="$(jq -r '.content_type // "application/octet-stream"' <<<"$row")"
  organization_prefix="organizations/$organization_id/"

  if [[ "$old_key" == organizations/* ]]; then
    echo "ERROR: $record_type $record_id belongs to $organization_id but uses another organization prefix." >&2
    exit 1
  fi

  new_key="$organization_prefix$old_key"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "Would move $record_type $record_id into $organization_prefix."
    continue
  fi

  source_file="$temporary_directory/source"
  verification_file="$temporary_directory/verification"
  rm -f -- "$source_file" "$verification_file"

  bunx wrangler r2 object get "$BUCKET/$old_key" \
    "${wrangler_storage_args[@]}" \
    --file "$source_file" >/dev/null
  bunx wrangler r2 object put "$BUCKET/$new_key" \
    "${wrangler_storage_args[@]}" --force \
    --file "$source_file" --content-type "$content_type" >/dev/null
  bunx wrangler r2 object get "$BUCKET/$new_key" \
    "${wrangler_storage_args[@]}" \
    --file "$verification_file" >/dev/null
  if ! cmp -s "$source_file" "$verification_file"; then
    echo "ERROR: Copied bytes did not match for $record_type $record_id." >&2
    exit 1
  fi

  escaped_record_id="$(sql_escape "$record_id")"
  escaped_organization_id="$(sql_escape "$organization_id")"
  escaped_old_key="$(sql_escape "$old_key")"
  escaped_new_key="$(sql_escape "$new_key")"
  case "$record_type" in
    upload)
      update_sql="UPDATE objects SET object_key = '$escaped_new_key' WHERE id = '$escaped_record_id' AND organization_id = '$escaped_organization_id' AND object_key = '$escaped_old_key' RETURNING id, object_key;"
      ;;
    inbound_email)
      update_sql="UPDATE inbound_emails SET raw_object_key = '$escaped_new_key' WHERE id = '$escaped_record_id' AND organization_id = '$escaped_organization_id' AND raw_object_key = '$escaped_old_key' RETURNING id, raw_object_key AS object_key;"
      ;;
    inbound_attachment)
      update_sql="UPDATE inbound_email_attachments SET object_key = '$escaped_new_key' WHERE id = '$escaped_record_id' AND object_key = '$escaped_old_key' AND email_id IN (SELECT id FROM inbound_emails WHERE organization_id = '$escaped_organization_id') RETURNING id, object_key;"
      ;;
    *)
      echo "ERROR: Unsupported record type: $record_type" >&2
      exit 1
      ;;
  esac

  update_json="$(
    bunx wrangler d1 execute stealth-db "${wrangler_storage_args[@]}" --json \
      --command "$update_sql"
  )"
  if ! jq -e --arg id "$record_id" --arg key "$new_key" \
    'any(.. | objects; .id? == $id and .object_key? == $key)' \
    >/dev/null <<<"$update_json"; then
    echo "ERROR: D1 did not update $record_type $record_id; the verified copy was retained." >&2
    exit 1
  fi

  bunx wrangler r2 object delete "$BUCKET/$old_key" \
    "${wrangler_storage_args[@]}" --force \
    >/dev/null
  moved_count=$((moved_count + 1))
  echo "Moved $record_type $record_id into $organization_prefix."
done <<<"$legacy_rows"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "Dry run complete; no data was changed."
else
  echo "Moved and verified $moved_count R2 object(s)."
fi
