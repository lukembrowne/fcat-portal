#!/bin/bash
#
# Copy deployment folders from BIOCHOCO_Data to BIOCHOCO_Data_test on Google Shared Drive.
# Uses rclone with the gdrive-biochoco: remote (must be configured).
#
# Usage:
#   ./scripts/copy-deployments-to-test-drive.sh CCN-001_V1 CCN-003_V1 GIZ-009_V1
#   ./scripts/copy-deployments-to-test-drive.sh --dry-run CCN-001_V1 CCN-003_V1
#

set -e

REMOTE="gdrive-biochoco"
SRC_BASE="${REMOTE}:BIOCHOCO_Data"
DEST_BASE="${REMOTE}:BIOCHOCO_Data_test/Biochoco"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

DRY_RUN=false
DEPLOYMENTS=()

# Parse arguments
for arg in "$@"; do
  if [ "$arg" = "--dry-run" ]; then
    DRY_RUN=true
  else
    DEPLOYMENTS+=("$arg")
  fi
done

if [ ${#DEPLOYMENTS[@]} -eq 0 ]; then
  echo "Usage: $0 [--dry-run] <deployment_id> [deployment_id ...]"
  echo ""
  echo "Copy deployment folders from BIOCHOCO_Data to BIOCHOCO_Data_test/Biochoco."
  echo ""
  echo "Options:"
  echo "  --dry-run  Show what would be copied without copying"
  echo ""
  echo "Examples:"
  echo "  $0 CCN-001_V1 CCN-003_V1 GIZ-009_V1"
  echo "  $0 --dry-run CCN-001_V1"
  exit 1
fi

# Check rclone is installed
if ! command -v rclone &> /dev/null; then
  echo -e "${RED}Error: rclone is not installed.${NC}"
  echo "Install it from https://rclone.org/install/"
  exit 1
fi

# Check remote is configured
if ! rclone listremotes | grep -q "^${REMOTE}:$"; then
  echo -e "${RED}Error: rclone remote '${REMOTE}' is not configured.${NC}"
  echo "Run 'rclone config' to set up the remote."
  exit 1
fi

echo ""
echo "=== Copy Deployments to Test Drive ==="
if $DRY_RUN; then
  echo -e "${YELLOW}DRY RUN — no files will be copied${NC}"
fi
echo ""
echo "Source:      ${SRC_BASE}/{id}"
echo "Destination: ${DEST_BASE}/{id}"
echo "Deployments: ${DEPLOYMENTS[*]}"
echo ""

succeeded=0
failed=0
skipped=0

for id in "${DEPLOYMENTS[@]}"; do
  src="${SRC_BASE}/${id}"
  dest="${DEST_BASE}/${id}"

  echo "--- ${id} ---"

  # Verify source exists by listing it (returns non-zero if not found)
  if ! rclone lsd "$src" --max-depth 0 2>/dev/null | grep -q .; then
    # lsd on the parent checking for the folder name
    if ! rclone lsd "${SRC_BASE}" 2>/dev/null | grep -q " ${id}$"; then
      echo -e "${YELLOW}  Skipped: source folder not found at ${src}${NC}"
      ((skipped++))
      echo ""
      continue
    fi
  fi

  if $DRY_RUN; then
    echo "  Would copy: ${src} → ${dest}"
    rclone copy "$src" "$dest" --dry-run 2>&1 | head -20
    echo -e "${GREEN}  (dry run)${NC}"
    ((succeeded++))
  else
    echo "  Copying: ${src} → ${dest}"
    if rclone copy "$src" "$dest" --progress --drive-server-side-across-configs 2>&1; then
      echo -e "${GREEN}  Done${NC}"
      ((succeeded++))
    else
      echo -e "${RED}  Failed${NC}"
      ((failed++))
    fi
  fi
  echo ""
done

echo "=== Summary ==="
echo -e "  ${GREEN}Succeeded: ${succeeded}${NC}"
if [ $failed -gt 0 ]; then
  echo -e "  ${RED}Failed:    ${failed}${NC}"
fi
if [ $skipped -gt 0 ]; then
  echo -e "  ${YELLOW}Skipped:   ${skipped}${NC}"
fi
echo ""
