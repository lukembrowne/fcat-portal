#!/bin/bash
#
# Refresh the Choconexión viewer's BioChoco bundle from production — locally.
#
# Pulls a production database snapshot to this machine, builds the bundle inside
# the dev container against that snapshot, and installs the result into the
# Choconexión checkout. The portal never has to be deployed for the viewer's
# data to be updated, and production is only ever read from.
#
# The snapshot is an hourly hot backup taken with SQLite's online backup API, so
# pulling one neither locks nor perturbs the live database. Media still comes
# from Google Drive live, using the service-account key already in .env.local.
#
# Usage:
#   ./scripts/refresh-choconexion-bundle.sh                 # pull prod, build, install
#   ./scripts/refresh-choconexion-bundle.sh --fresh         # ask prod for a new backup first
#   ./scripts/refresh-choconexion-bundle.sh --skip-pull     # reuse the snapshot on disk
#   ./scripts/refresh-choconexion-bundle.sh --dev-db        # build from local dev data instead
#   ./scripts/refresh-choconexion-bundle.sh --no-install    # build only; don't touch the repo
#   ./scripts/refresh-choconexion-bundle.sh --repo ../other-checkout
#
# Requires: ssh access to the `digitalocean` host, the dev container running.

set -euo pipefail

SERVER="${CHOCONEXION_SERVER:-digitalocean}"
SERVER_PATH="/root/opt/fcat-portal"
SNAPSHOT="data/prod-snapshot.db"
REPO="${CHOCONEXION_REPO:-../fcat-choconexion}"

SKIP_PULL=false
FRESH=false
INSTALL=true
DEV_DB=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-pull)  SKIP_PULL=true; shift ;;
    --fresh)      FRESH=true; shift ;;
    --no-install) INSTALL=false; shift ;;
    --dev-db)     DEV_DB=true; SKIP_PULL=true; shift ;;
    --repo)       REPO="$2"; shift 2 ;;
    -h|--help)    sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'
step() { echo ""; echo -e "${BOLD}==> $1${NC}"; }
fail() { echo -e "${RED}✗ $1${NC}" >&2; exit 1; }

cd "$(dirname "$0")/.."

# --- Preflight -------------------------------------------------------------
docker compose ps --status running 2>/dev/null | grep -q portal \
  || fail "The dev container isn't running. Start it with: docker compose up -d"

if [ "$INSTALL" = true ]; then
  [ -d "$REPO" ] || fail "Choconexión checkout not found at: $REPO  (pass --repo PATH)"
  [ -f "$REPO/scripts/verify-sites.mjs" ] \
    || fail "$REPO doesn't look like the Choconexión checkout (no scripts/verify-sites.mjs)"
  REPO="$(cd "$REPO" && pwd)"
fi

if [ "$DEV_DB" = true ]; then
  DB_ARG="data/portal.db"
  echo -e "${YELLOW}Building from LOCAL DEV data — not production.${NC}"
else
  DB_ARG="$SNAPSHOT"
fi

# --- 1. Pull the production snapshot ---------------------------------------
if [ "$SKIP_PULL" = false ]; then
  if [ "$FRESH" = true ]; then
    step "Asking production for a fresh hot backup"
    ssh "$SERVER" "cd $SERVER_PATH && docker compose exec -T portal node scripts/backup-db.mjs" \
      || fail "Backup on production failed."
  fi

  step "Finding the newest production backup"
  LATEST="$(ssh "$SERVER" "ls -1 $SERVER_PATH/data/backups/portal-*.db.gz 2>/dev/null | sort | tail -1")"
  [ -n "$LATEST" ] || fail "No backups found in $SERVER_PATH/data/backups/"
  echo "    $(basename "$LATEST")"

  step "Downloading (~250 MB compressed)"
  mkdir -p data
  scp "$SERVER:$LATEST" "$SNAPSHOT.gz"

  step "Unpacking to $SNAPSHOT"
  # Stale WAL/SHM from an earlier run would be applied on top of the new file.
  rm -f "$SNAPSHOT" "$SNAPSHOT-wal" "$SNAPSHOT-shm"
  gunzip -f "$SNAPSHOT.gz"
  echo "    $(du -h "$SNAPSHOT" | cut -f1)"
elif [ "$DEV_DB" = false ]; then
  [ -f "$SNAPSHOT" ] || fail "No snapshot at $SNAPSHOT — run without --skip-pull first."
  step "Reusing existing snapshot ($(du -h "$SNAPSHOT" | cut -f1), $(date -r "$SNAPSHOT" '+%Y-%m-%d %H:%M'))"
fi

# --- 2. Build the bundle in the container ----------------------------------
step "Building the bundle"
# --conditions=react-server makes `import "server-only"` resolve to its empty
# stub; without it the export core throws on import outside Next.js.
LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT
docker compose exec -T \
  -e NODE_OPTIONS=--conditions=react-server \
  portal npx tsx scripts/export-choconexion-bundle.ts --db "$DB_ARG" 2>&1 | tee "$LOG"

BUNDLE_DIR="$(grep -o '^BUNDLE_DIR=.*' "$LOG" | tail -1 | cut -d= -f2-)"
[ -n "$BUNDLE_DIR" ] || fail "The exporter did not report a bundle directory."
[ -f "$BUNDLE_DIR/data/sites.json" ] || fail "No sites.json in $BUNDLE_DIR"

if [ "$INSTALL" = false ]; then
  echo ""
  echo -e "${GREEN}✓ Bundle built at $BUNDLE_DIR${NC} (not installed)"
  exit 0
fi

# --- 3. Install into the Choconexión checkout ------------------------------
step "Installing into $REPO"
[ -d "$BUNDLE_DIR/sites" ] \
  || fail "The bundle has no sites/ directory — every media fetch failed. Repo left untouched."
mkdir -p "$REPO/public/data"
cp "$BUNDLE_DIR/data/sites.json" "$REPO/public/data/sites.json"
# Replace rather than merge: a site that lost its last photo upstream must lose
# the files too, or verify-sites.mjs passes on assets nothing references.
rm -rf "$REPO/public/sites"
cp -R "$BUNDLE_DIR/sites" "$REPO/public/sites"
echo "    $(find "$REPO/public/sites" -type f | wc -l | tr -d ' ') asset files"

# --- 4. Verify -------------------------------------------------------------
step "Verifying"
(cd "$REPO" && node scripts/verify-sites.mjs) || fail "Verification failed — do NOT commit this bundle."

# --- 5. Prune ---------------------------------------------------------------
# Each run leaves a full copy of the bundle behind. Keep a few to diff against;
# drop the rest, since the installed copy in the repo is the one that matters.
# `ls -1dt` is newest-first and `tail -n +N` is portable; `head -n -N` is a GNU
# extension that BSD head rejects outright, so on macOS it pruned nothing.
KEPT=3
ls -1dt data/exports/choconexion/*/ 2>/dev/null | tail -n +$((KEPT + 1)) | while read -r old; do
  echo "    pruning $(basename "$old")"
  rm -rf "$old"
done

echo ""
echo -e "${GREEN}✓ Done.${NC} Review the viewer, then commit in $REPO:"
echo ""
(cd "$REPO" && git status --short public/data/sites.json public/sites | head -5)
echo ""
echo "    cd $REPO && npm run dev     # look at a few site panels"
echo "    git add public/data/sites.json public/sites && git commit"
if [ -f "$SNAPSHOT" ]; then
  echo ""
  echo "The production snapshot ($(du -h "$SNAPSHOT" | cut -f1)) is kept at $SNAPSHOT for"
  echo "re-runs with --skip-pull. Delete it when you're done: rm -f $SNAPSHOT*"
fi
