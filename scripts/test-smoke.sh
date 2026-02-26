#!/usr/bin/env bash
# test-smoke.sh — Smoke test that visits every major page and verifies it loads.
#
# Prerequisites:
#   - agent-browser installed: npm install -g agent-browser && agent-browser install
#   - Dev server running at localhost:3003 with DEV_USER_EMAIL set
#
# Usage:
#   ./scripts/test-smoke.sh
#   ./scripts/test-smoke.sh --headed   # visible browser window

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3003}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCREENSHOT_DIR="$SCRIPT_DIR/../data/test-screenshots"
HEADED_FLAG=""

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

PASSED=0
FAILED=0
TOTAL=0
FAILURES=""

test_page() {
  local slug="$1" url="$2" verify_text="${3:-}"
  TOTAL=$((TOTAL + 1))
  local full_url="$BASE_URL$url"

  $AB open "$full_url" > /dev/null 2>&1
  $AB wait 2000 > /dev/null 2>&1

  $AB screenshot "$SCREENSHOT_DIR/smoke-${slug}.png" > /dev/null 2>&1

  local snapshot
  snapshot=$($AB snapshot 2>/dev/null) || snapshot=""

  # Check for error indicators
  local has_error=false
  if grep -qiE '(Application error|NEXT_NOT_FOUND|Internal Server Error)' <<< "$snapshot"; then
    has_error=true
  fi
  # Check page title for error codes
  local title
  title=$($AB get title 2>/dev/null) || title=""
  if grep -qiE '(404|500|Error)' <<< "$title"; then
    has_error=true
  fi

  if [ "$has_error" = true ]; then
    FAILED=$((FAILED + 1))
    FAILURES="$FAILURES  FAIL $url ($slug) — error indicator found\n"
    echo "  FAIL  $url  ($slug) — error indicator found"
    return
  fi

  # If verify text specified, check it exists in snapshot
  if [ -n "$verify_text" ]; then
    if ! grep -qi "$verify_text" <<< "$snapshot"; then
      FAILED=$((FAILED + 1))
      FAILURES="$FAILURES  FAIL $url ($slug) — '$verify_text' not found\n"
      echo "  FAIL  $url  ($slug) — '$verify_text' not found"
      return
    fi
  fi

  PASSED=$((PASSED + 1))
  echo "  PASS  $url  ($slug)"
}

echo "=== Smoke Test: All Major Pages ==="
echo "Base URL: $BASE_URL"
echo ""

# Open browser with first page
echo "Starting browser..."
$AB open "$BASE_URL" > /dev/null 2>&1
$AB wait 2000 > /dev/null 2>&1
echo ""

test_page "home"              "/"                      "FCAT"
test_page "camera-trap"       "/camera-trap"           "Instalaciones"
test_page "species"           "/camera-trap/species"   "Especies"
test_page "results"           "/camera-trap/results"   ""
test_page "favorites"         "/camera-trap/favorites" ""
test_page "audio"             "/audio"                 ""
test_page "biochoco-overview" "/biochoco/overview"     "Cronograma"
test_page "biochoco-data"     "/biochoco/data"         ""
test_page "biochoco-habitat"  "/biochoco/habitat"      ""
test_page "biochoco-ibutton"  "/biochoco/ibutton"      ""
test_page "climate-dashboard" "/climate/dashboard"     ""
test_page "climate-upload"    "/climate/upload"        ""
test_page "finance-cashflow"  "/finance/cashflow"      ""
test_page "finance-revenue"   "/finance/revenue"       ""
test_page "finance-expenses"  "/finance/expenses"      ""
test_page "finance-sueldos"   "/finance/sueldos"       ""
test_page "finance-budget"    "/finance/budget"        ""
test_page "finance-data"      "/finance/data"          ""
test_page "admin"             "/admin"                 "Administración"

echo ""
echo "=== Results: $PASSED/$TOTAL passed ==="
if [ "$FAILED" -gt 0 ]; then
  echo ""
  echo "Failures:"
  echo -e "$FAILURES"
  exit 1
else
  echo "All pages loaded successfully."
  exit 0
fi
