#!/usr/bin/env bash
set -euo pipefail
umask 077

REPO_ROOT="$(git rev-parse --show-toplevel)"
SOURCE_DIRS_REL=(".secrets")
if [[ -d "$REPO_ROOT/.test_files" ]]; then
  SOURCE_DIRS_REL+=(".test_files")
fi
SOURCE_DIRS=("${SOURCE_DIRS_REL[@]/#/$REPO_ROOT/}")
DEFAULT_OUTPUT_DIR="$HOME/stealth-backups"
OUTPUT_DIR="$DEFAULT_OUTPUT_DIR"
PASSWORD=""
NO_PASSWORD=false
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE_EXTENSION=".zip"

usage() {
  echo "Usage: backupSharedData.sh [output_dir] [--password <password>] [--no-password]"
}

output_dir_set=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --password)
      if [[ $# -lt 2 ]]; then
        echo "backupSharedData: missing value for --password" >&2
        usage >&2
        exit 1
      fi
      PASSWORD="$2"
      if [[ -z "$PASSWORD" ]]; then
        echo "backupSharedData: --password cannot be empty" >&2
        exit 1
      fi
      shift 2
      ;;
    --password=*)
      PASSWORD="${1#*=}"
      if [[ -z "$PASSWORD" ]]; then
        echo "backupSharedData: --password cannot be empty" >&2
        exit 1
      fi
      shift
      ;;
    --no-password)
      NO_PASSWORD=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      echo "backupSharedData: unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [[ "$output_dir_set" -eq 1 ]]; then
        echo "backupSharedData: too many positional arguments" >&2
        usage >&2
        exit 1
      fi
      OUTPUT_DIR="${1/#~/$HOME}"
      output_dir_set=1
      shift
      ;;
  esac
done

if [[ -n "$PASSWORD" && "$NO_PASSWORD" == true ]]; then
  echo "backupSharedData: --password and --no-password cannot be combined" >&2
  exit 1
fi
if [[ -z "$PASSWORD" && "$NO_PASSWORD" != true && ! -t 0 ]]; then
  echo "backupSharedData: non-interactive backups require --password or explicit --no-password" >&2
  exit 1
fi

if ! command -v zip >/dev/null 2>&1; then
  echo "backupSharedData: 'zip' command not found." >&2
  exit 1
fi
if [[ "$NO_PASSWORD" != true ]] && ! command -v gpg >/dev/null 2>&1; then
  echo "backupSharedData: 'gpg' command not found." >&2
  exit 1
fi

if [[ "$NO_PASSWORD" != true ]]; then
  ARCHIVE_EXTENSION="${ARCHIVE_EXTENSION}.gpg"
fi

mkdir -p "$OUTPUT_DIR"

OUTPUT_ABS="$(cd "$OUTPUT_DIR" && pwd -P)"

for source_dir in "${SOURCE_DIRS[@]}"; do
  if [[ ! -d "$source_dir" ]]; then
    echo "backupSharedData: source directory not found: $source_dir" >&2
    exit 1
  fi

  source_abs="$(cd "$source_dir" && pwd -P)"
  if [[ "$source_abs" == "/" ]]; then
    echo "backupSharedData: source directory cannot be the root directory: $source_dir" >&2
    exit 1
  fi
  if [[ "$OUTPUT_ABS" == "$source_abs" || "$OUTPUT_ABS" == "$source_abs/"* ]]; then
    echo "backupSharedData: output directory cannot be inside a source directory: $OUTPUT_ABS" >&2
    exit 1
  fi
done

# A private directory reserves a unique suffix for concurrent backups. Keep
# the in-progress archive there and hard-link it into place only on success;
# ln refuses to replace an existing destination.
RESERVATION_DIR="$(mktemp -d "$OUTPUT_ABS/.shared-data-backup-${TIMESTAMP}.XXXXXX")"
TEMP_ARCHIVE="$RESERVATION_DIR/archive$ARCHIVE_EXTENSION"
trap 'rm -f "$TEMP_ARCHIVE"; rmdir "$RESERVATION_DIR"' EXIT
ARCHIVE_PATH="$OUTPUT_ABS/shared-data-backup-${TIMESTAMP}-${RESERVATION_DIR##*.}$ARCHIVE_EXTENSION"

# Zip from repo root to maintain relative paths in archive. Encrypted mode
# streams directly into GPG so the plaintext archive is never written to disk.
if [[ "$NO_PASSWORD" == true ]]; then
  (cd "$REPO_ROOT" && zip -r "$TEMP_ARCHIVE" "${SOURCE_DIRS_REL[@]}" >/dev/null)
elif [[ -n "$PASSWORD" ]]; then
  echo "backupSharedData: WARNING: --password exposes the passphrase in the backup command's process list." >&2
  (cd "$REPO_ROOT" && zip -r - "${SOURCE_DIRS_REL[@]}" 2>/dev/null) |
    gpg --batch --yes --pinentry-mode loopback --passphrase-fd 3 \
      --symmetric --cipher-algo AES256 --force-aead --output "$TEMP_ARCHIVE" \
      3<<<"$PASSWORD"
else
  (cd "$REPO_ROOT" && zip -r - "${SOURCE_DIRS_REL[@]}" 2>/dev/null) |
    gpg --symmetric --cipher-algo AES256 --force-aead --output "$TEMP_ARCHIVE"
fi
ln "$TEMP_ARCHIVE" "$ARCHIVE_PATH"

echo "Created backup: $ARCHIVE_PATH"
echo "Backed up directories: ${SOURCE_DIRS_REL[*]}"
