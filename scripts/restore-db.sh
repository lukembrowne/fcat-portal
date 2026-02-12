#!/bin/bash
#
# Restore a database backup
#
# Usage:
#   ./scripts/restore-db.sh              # List backups interactively
#   ./scripts/restore-db.sh latest       # Restore the latest backup
#   ./scripts/restore-db.sh <filename>   # Restore a specific backup
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

# Check backup directory exists
if [ ! -d "$BACKUP_DIR" ]; then
  echo -e "${RED}Error: Backup directory not found: $BACKUP_DIR${NC}"
  exit 1
fi

# List available backups (newest first)
mapfile -t BACKUPS < <(ls -t "$BACKUP_DIR"/portal-*.db 2>/dev/null)

if [ ${#BACKUPS[@]} -eq 0 ]; then
  echo -e "${RED}No backups found in $BACKUP_DIR${NC}"
  exit 1
fi

# Handle arguments
SELECTED=""
if [ "$1" = "latest" ]; then
  SELECTED="${BACKUPS[0]}"
  echo -e "Using latest backup: ${GREEN}$(basename "$SELECTED")${NC}"
elif [ -n "$1" ]; then
  if [ -f "$BACKUP_DIR/$1" ]; then
    SELECTED="$BACKUP_DIR/$1"
  elif [ -f "$1" ]; then
    SELECTED="$1"
  else
    echo -e "${RED}Backup not found: $1${NC}"
    exit 1
  fi
  echo -e "Using backup: ${GREEN}$(basename "$SELECTED")${NC}"
else
  # Interactive: show list
  echo "Available backups:"
  echo ""
  for i in "${!BACKUPS[@]}"; do
    FILE="${BACKUPS[$i]}"
    SIZE=$(du -h "$FILE" | cut -f1)
    NAME=$(basename "$FILE")
    # Cross-platform age calculation
    if stat -f %m "$FILE" > /dev/null 2>&1; then
      MTIME=$(stat -f %m "$FILE")  # macOS
    else
      MTIME=$(stat -c %Y "$FILE")  # Linux
    fi
    AGE_SEC=$(( $(date +%s) - MTIME ))
    AGE_HOURS=$(( AGE_SEC / 3600 ))
    AGE_DAYS=$(( AGE_HOURS / 24 ))

    if [ $AGE_DAYS -gt 0 ]; then
      AGE="${AGE_DAYS}d $((AGE_HOURS % 24))h ago"
    else
      AGE="${AGE_HOURS}h ago"
    fi

    printf "  %2d) %s  (%s, %s)\n" $((i+1)) "$NAME" "$SIZE" "$AGE"
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

  SELECTED="${BACKUPS[$INDEX]}"
fi

# Confirm
echo ""
echo -e "${YELLOW}WARNING: This will replace the current database with the backup.${NC}"
echo "  Current DB: $DB_PATH"
echo "  Backup:     $(basename "$SELECTED")"
echo ""
read -p "Continue? (y/N) " CONFIRM

if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
  echo "Aborted."
  exit 0
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

# Restore
echo "Restoring database from $(basename "$SELECTED")..."
cp "$SELECTED" "$DB_PATH"

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
echo "Restored from: $(basename "$SELECTED")"
echo "Pre-restore backup saved: ${DB_PATH}.pre-restore"
echo ""
echo "The portal's startup integrity check will verify the database."
echo "If the portal fails to start, recover with:"
echo "  cp ${DB_PATH}.pre-restore ${DB_PATH} && docker compose start portal"
