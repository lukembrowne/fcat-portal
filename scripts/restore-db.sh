#!/bin/bash
#
# Restore a database backup (local or offloaded to a DigitalOcean Space)
#
# Usage:
#   ./scripts/restore-db.sh              # List backups (local + Space) interactively
#   ./scripts/restore-db.sh latest       # Restore the newest backup (any source)
#   ./scripts/restore-db.sh <filename>   # Restore a specific backup (local or Space)
#
# Backups may be compressed (portal-*.db.gz) or legacy uncompressed (portal-*.db),
# and may live locally in data/backups/ and/or in the Space. When the selected
# backup only exists in the Space, it is downloaded automatically (needs s3cmd +
# SPACES_* env vars). Filenames embed an ISO timestamp, so lexical sort == newest-first.
#
# The portal's startup integrity check will verify the restored DB.
# If it fails, recover with: cp data/portal.db.pre-restore data/portal.db

set -e

DATA_DIR="${DATA_DIR:-./data}"
DB_PATH="${DATA_DIR}/portal.db"
BACKUP_DIR="${DATA_DIR}/backups"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo "=== FCAT Portal Database Restore ==="
echo ""

# --- Space (offload) config ------------------------------------------------
OFFLOAD_CONFIGURED=false
if [ -n "$SPACES_BUCKET" ] && [ -n "$SPACES_KEY" ] && [ -n "$SPACES_SECRET" ] && [ -n "$SPACES_ENDPOINT" ] && command -v s3cmd >/dev/null 2>&1; then
  OFFLOAD_CONFIGURED=true
fi

s3_flags() {
  echo "--access_key=${SPACES_KEY} --secret_key=${SPACES_SECRET} --host=${SPACES_ENDPOINT} --host-bucket=%(bucket)s.${SPACES_ENDPOINT}"
}

# --- Collect candidate backups (names only; timestamp sorts lexically) -----
declare -A IS_LOCAL
declare -A IN_SPACE

if [ -d "$BACKUP_DIR" ]; then
  for f in "$BACKUP_DIR"/portal-*.db.gz "$BACKUP_DIR"/portal-*.db; do
    [ -e "$f" ] || continue
    IS_LOCAL["$(basename "$f")"]=1
  done
fi

if [ "$OFFLOAD_CONFIGURED" = true ]; then
  while IFS= read -r name; do
    [ -n "$name" ] && IN_SPACE["$name"]=1
  done < <(s3cmd ls "s3://${SPACES_BUCKET}/" $(s3_flags) 2>/dev/null | grep -oE 'portal-[^/[:space:]]+\.db(\.gz)?$' || true)
fi

# Merge, dedup, newest-first (filenames embed ISO timestamps → reverse sort).
mapfile -t BACKUPS < <(printf '%s\n' "${!IS_LOCAL[@]}" "${!IN_SPACE[@]}" | sort -u -r)

if [ ${#BACKUPS[@]} -eq 0 ]; then
  echo -e "${RED}No backups found (local: $BACKUP_DIR${NC}$([ "$OFFLOAD_CONFIGURED" = true ] && echo ", Space: $SPACES_BUCKET"))"
  exit 1
fi

source_label() {
  local name="$1"
  if [ -n "${IS_LOCAL[$name]}" ] && [ -n "${IN_SPACE[$name]}" ]; then echo "local+Space";
  elif [ -n "${IS_LOCAL[$name]}" ]; then echo "local";
  else echo "Space"; fi
}

# Handle arguments
SELECTED_NAME=""
if [ "$1" = "latest" ]; then
  SELECTED_NAME="${BACKUPS[0]}"
  echo -e "Using latest backup: ${GREEN}${SELECTED_NAME}${NC} ($(source_label "$SELECTED_NAME"))"
elif [ -n "$1" ]; then
  ARG_NAME="$(basename "$1")"
  if [ -n "${IS_LOCAL[$ARG_NAME]}" ] || [ -n "${IN_SPACE[$ARG_NAME]}" ]; then
    SELECTED_NAME="$ARG_NAME"
  elif [ -f "$1" ]; then
    # Absolute/relative path to a file outside the backup dir
    SELECTED_NAME=""
    SELECTED_PATH="$1"
  else
    echo -e "${RED}Backup not found: $1${NC}"
    exit 1
  fi
  [ -n "$SELECTED_NAME" ] && echo -e "Using backup: ${GREEN}${SELECTED_NAME}${NC} ($(source_label "$SELECTED_NAME"))"
else
  # Interactive: show list
  echo "Available backups:"
  echo ""
  for i in "${!BACKUPS[@]}"; do
    NAME="${BACKUPS[$i]}"
    LABEL="$(source_label "$NAME")"
    if [ -n "${IS_LOCAL[$NAME]}" ]; then
      SIZE=$(du -h "$BACKUP_DIR/$NAME" | cut -f1)
    else
      SIZE="?"
    fi
    printf "  %2d) %s  (%s, %s)\n" $((i+1)) "$NAME" "$SIZE" "$LABEL"
  done

  echo ""
  read -p "Select backup number (1-${#BACKUPS[@]}), or 'q' to quit: " CHOICE

  if [ "$CHOICE" = "q" ] || [ -z "$CHOICE" ]; then
    echo "Aborted."
    exit 0
  fi

  INDEX=$((CHOICE - 1))
  if [ $INDEX -lt 0 ] || [ $INDEX -ge ${#BACKUPS[@]} ]; then
    echo -e "${RED}Invalid selection${NC}"
    exit 1
  fi

  SELECTED_NAME="${BACKUPS[$INDEX]}"
fi

# Confirm
echo ""
echo -e "${YELLOW}WARNING: This will replace the current database with the backup.${NC}"
echo "  Current DB: $DB_PATH"
echo "  Backup:     ${SELECTED_NAME:-$SELECTED_PATH}"
echo ""
read -p "Continue? (y/N) " CONFIRM

if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
  echo "Aborted."
  exit 0
fi

# --- Resolve the selected backup to a local file (download if Space-only) ---
TMP_DOWNLOAD=""
cleanup_tmp() { [ -n "$TMP_DOWNLOAD" ] && rm -f "$TMP_DOWNLOAD"; }
trap cleanup_tmp EXIT

if [ -n "$SELECTED_NAME" ]; then
  if [ -n "${IS_LOCAL[$SELECTED_NAME]}" ]; then
    SELECTED_PATH="$BACKUP_DIR/$SELECTED_NAME"
  else
    # Space-only → download to a temp file first (never straight over portal.db).
    echo "Downloading from Space: $SELECTED_NAME ..."
    TMP_DOWNLOAD="$(mktemp "${TMPDIR:-/tmp}/portal-restore-XXXXXX")"
    if ! s3cmd get --force "s3://${SPACES_BUCKET}/${SELECTED_NAME}" "$TMP_DOWNLOAD" $(s3_flags); then
      echo -e "${RED}Download failed — aborting before touching the live database.${NC}"
      exit 1
    fi
    SELECTED_PATH="$TMP_DOWNLOAD"
  fi
fi

# Stop the portal container
echo ""
echo "Stopping portal container..."
docker compose stop portal 2>/dev/null || true

# Safety net: copy current DB
if [ -f "$DB_PATH" ]; then
  echo "Creating safety backup: portal.db.pre-restore"
  cp "$DB_PATH" "${DB_PATH}.pre-restore"
fi

# Restore — decompress .gz, else plain copy. Write to a temp then move into place
# so a failed decompression never leaves a half-written portal.db.
echo "Restoring database from ${SELECTED_NAME:-$(basename "$SELECTED_PATH")}..."
RESTORE_TMP="${DB_PATH}.restore-tmp"
rm -f "$RESTORE_TMP"
case "$SELECTED_PATH" in
  *.gz)
    if ! gunzip -c "$SELECTED_PATH" > "$RESTORE_TMP"; then
      echo -e "${RED}Decompression failed — live database left untouched.${NC}"
      rm -f "$RESTORE_TMP"
      docker compose start portal 2>/dev/null || true
      exit 1
    fi
    ;;
  *)
    cp "$SELECTED_PATH" "$RESTORE_TMP"
    ;;
esac
mv "$RESTORE_TMP" "$DB_PATH"

# Remove WAL/SHM files for a fresh start
rm -f "${DB_PATH}-wal" "${DB_PATH}-shm"

# Restart
echo "Starting portal container..."
docker compose start portal

# Wait a moment and check
sleep 3

echo ""
echo -e "${GREEN}=== Restore Complete ===${NC}"
echo ""
echo "Restored from: ${SELECTED_NAME:-$(basename "$SELECTED_PATH")}"
echo "Pre-restore backup saved: ${DB_PATH}.pre-restore"
echo ""
echo "The portal's startup integrity check will verify the database."
echo "If the portal fails to start, recover with:"
echo "  cp ${DB_PATH}.pre-restore ${DB_PATH} && docker compose start portal"
