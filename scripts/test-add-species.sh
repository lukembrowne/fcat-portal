#!/usr/bin/env bash
# test-add-species.sh — Uses agent-browser to add a species via the UI and verify it appears.
#
# Prerequisites:
#   - agent-browser installed: npm install -g agent-browser && agent-browser install
#   - Dev server running at localhost:3003 with DEV_USER_EMAIL set
#
# Usage:
#   ./scripts/test-add-species.sh
#   ./scripts/test-add-species.sh --headed   # visible browser window

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3003}"
SPECIES_URL="$BASE_URL/camera-trap/species"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCREENSHOT_DIR="$SCRIPT_DIR/../data/test-screenshots"
HEADED_FLAG=""
TEST_SCIENTIFIC="Panthera onca"
TEST_COMMON="Jaguar"
TEST_SPANISH="Jaguar"

# Parse args
for arg in "$@"; do
  case "$arg" in
    --headed) HEADED_FLAG="--headed" ;;
  esac
done

AB="agent-browser $HEADED_FLAG"

mkdir -p "$SCREENSHOT_DIR"

cleanup() {
  $AB close 2>/dev/null || true
}
trap cleanup EXIT

echo "=== Test: Add Species via UI ==="
echo "URL: $SPECIES_URL"
echo ""

# Step 1: Open species page
echo "[1/12] Opening species page..."
$AB open "$SPECIES_URL" > /dev/null
$AB wait 2000 > /dev/null

# Step 2: Screenshot before state
echo "[2/12] Screenshotting before state..."
$AB screenshot "$SCREENSHOT_DIR/species-before.png" > /dev/null
echo "  saved: data/test-screenshots/species-before.png"

# Step 3: Find and click "Agregar Especie" button
echo "[3/12] Clicking 'Agregar Especie'..."
SNAPSHOT=$($AB snapshot -i)

# Extract the ref for the "Agregar Especie" button
ADD_REF=$(echo "$SNAPSHOT" | grep -i "Agregar Especie" | grep -oE 'e[0-9]+' | head -1)
if [ -z "$ADD_REF" ]; then
  echo "  FAIL: Could not find 'Agregar Especie' button"
  echo "  Snapshot (first 10 lines):"
  echo "$SNAPSHOT" | head -10
  exit 1
fi
echo "  found @$ADD_REF"
$AB click "@$ADD_REF" > /dev/null
$AB wait 1000 > /dev/null

# Step 4: Snapshot the dialog to find form fields
echo "[4/12] Reading dialog form..."
DIALOG=$($AB snapshot -i)

# Extract textbox refs — they appear in dialog order: scientific, common, spanish, (search is behind dialog)
# Filter to only textboxes that are inside the dialog (have placeholder hints from the form)
TEXTBOX_LINES=$(echo "$DIALOG" | grep -i 'textbox' | grep -ivE 'Buscar')
SCIENTIFIC_REF=$(echo "$TEXTBOX_LINES" | sed -n '1p' | grep -oE 'e[0-9]+' | head -1)
COMMON_REF=$(echo "$TEXTBOX_LINES" | sed -n '2p' | grep -oE 'e[0-9]+' | head -1)
SPANISH_REF=$(echo "$TEXTBOX_LINES" | sed -n '3p' | grep -oE 'e[0-9]+' | head -1)

if [ -z "$SCIENTIFIC_REF" ] || [ -z "$COMMON_REF" ]; then
  echo "  FAIL: Could not find form inputs in dialog"
  echo "  Textbox lines found:"
  echo "$TEXTBOX_LINES"
  exit 1
fi

# Step 5: Fill form fields
echo "[5/12] Filling form..."
$AB fill "@$SCIENTIFIC_REF" "$TEST_SCIENTIFIC" > /dev/null
echo "  scientificName (@$SCIENTIFIC_REF) = $TEST_SCIENTIFIC"
$AB fill "@$COMMON_REF" "$TEST_COMMON" > /dev/null
echo "  commonName (@$COMMON_REF) = $TEST_COMMON"
if [ -n "$SPANISH_REF" ]; then
  $AB fill "@$SPANISH_REF" "$TEST_SPANISH" > /dev/null
  echo "  spanishName (@$SPANISH_REF) = $TEST_SPANISH"
fi

# Step 6: Click submit button ("Agregar" — not "Agregar Especie")
echo "[6/12] Submitting..."
SUBMIT_SNAP=$($AB snapshot -i)
SUBMIT_REF=$(echo "$SUBMIT_SNAP" | grep -E 'button.*"Agregar"' | grep -v "Especie" | grep -oE 'e[0-9]+' | head -1)
if [ -z "$SUBMIT_REF" ]; then
  echo "  FAIL: Could not find 'Agregar' submit button"
  echo "  Buttons found:"
  echo "$SUBMIT_SNAP" | grep -i 'button'
  exit 1
fi
echo "  submit button @$SUBMIT_REF"
$AB click "@$SUBMIT_REF" > /dev/null

# Step 7: Wait for server action + page refresh
echo "[7/12] Waiting for save..."
$AB wait 3000 > /dev/null

# Step 8: Verify species appears in the table
echo "[8/12] Verifying..."
$AB screenshot "$SCREENSHOT_DIR/species-after.png" > /dev/null
echo "  saved: data/test-screenshots/species-after.png"

FINAL=$($AB snapshot)
if echo "$FINAL" | grep -q "$TEST_SCIENTIFIC"; then
  echo ""
  echo "PASS: '$TEST_SCIENTIFIC' found in species table"
else
  echo ""
  echo "FAIL: '$TEST_SCIENTIFIC' not found after submission"
  echo ""
  echo "Page text (first 30 lines):"
  echo "$FINAL" | head -30
  exit 1
fi

# --- Cleanup: delete the test species ---
echo ""
echo "=== Cleanup: Remove test species ==="

# Step 9: Find the Eliminar button for the test species row
echo "[9/12] Finding 'Eliminar' button for test species..."
CLEANUP_SNAP=$($AB snapshot -i)

# Find the line with the test species, then find the nearest Eliminar button after it
SPECIES_LINE=$(echo "$CLEANUP_SNAP" | grep -n "$TEST_SCIENTIFIC" | head -1 | cut -d: -f1)
if [ -z "$SPECIES_LINE" ]; then
  echo "  WARNING: Could not find test species row for cleanup"
  echo "  Species may remain in table — delete manually"
  exit 0
fi

# Look for Eliminar button near/after the species line
DELETE_REF=$(echo "$CLEANUP_SNAP" | tail -n +"$SPECIES_LINE" | grep -i "Eliminar" | grep -oE 'e[0-9]+' | head -1)
if [ -z "$DELETE_REF" ]; then
  echo "  WARNING: Could not find 'Eliminar' button for test species"
  echo "  Species may remain in table — delete manually"
  exit 0
fi
echo "  found @$DELETE_REF"

# Step 10: Click Eliminar to open confirmation dialog
echo "[10/12] Clicking 'Eliminar'..."
$AB click "@$DELETE_REF" > /dev/null
$AB wait 1000 > /dev/null

# Step 11: Confirm deletion in the dialog
echo "[11/12] Confirming deletion..."
CONFIRM_SNAP=$($AB snapshot -i)
CONFIRM_REF=$(echo "$CONFIRM_SNAP" | grep -iE 'button.*Eliminar' | grep -oE 'e[0-9]+' | head -1)
if [ -z "$CONFIRM_REF" ]; then
  echo "  WARNING: Could not find confirmation button"
  echo "  Species may remain in table — delete manually"
  exit 0
fi
echo "  confirm button @$CONFIRM_REF"
$AB click "@$CONFIRM_REF" > /dev/null
$AB wait 2000 > /dev/null

# Step 12: Verify species is gone
echo "[12/12] Verifying cleanup..."
$AB screenshot "$SCREENSHOT_DIR/species-cleaned.png" > /dev/null
echo "  saved: data/test-screenshots/species-cleaned.png"

CLEANED=$($AB snapshot)
if echo "$CLEANED" | grep -q "$TEST_SCIENTIFIC"; then
  echo ""
  echo "  WARNING: '$TEST_SCIENTIFIC' still present after cleanup attempt"
  echo "  Species may remain in table — delete manually"
else
  echo ""
  echo "  Cleanup OK: '$TEST_SCIENTIFIC' removed from species table"
fi

exit 0
