#!/bin/bash
#
# reclaim-disk.sh — safe, idempotent disk reclaim for the FCAT Portal data dir.
#
# Covers the SAFE, repeatable reclaim steps only:
#   1. Delete stray one-off DB copies (portal.db.bak-precancel-*, portal.db.pre-restore)
#   2. Gzip existing uncompressed backups (portal-*.db -> portal-*.db.gz), preserving mtime
#   3. (--migrate-backups) Upload every .db.gz to the Space, verify, then prune
#      local down to the newest few — upload-verify-then-prune (never prune an
#      un-uploaded file).
#
# It deliberately does NOT run `docker system prune` or delete ct-images cache —
# those are operator-driven and documented in docs/operations/disk-space-runbook.md,
# because they need a per-item safety review (co-tenant volumes / active jobs).
#
# The live database (data/portal.db) is NEVER touched.
#
# Usage:
#   ./scripts/reclaim-disk.sh --dry-run          # show what would happen, change nothing
#   ./scripts/reclaim-disk.sh                    # delete strays + compress backups
#   ./scripts/reclaim-disk.sh --migrate-backups  # also upload to Space + prune local
#
# Runs on the host or inside the container. Set DATA_DIR to override ./data.

set -euo pipefail

DATA_DIR="${DATA_DIR:-./data}"
BACKUP_DIR="${DATA_DIR}/backups"
DB_PATH="${DATA_DIR}/portal.db"

DRY_RUN=false
MIGRATE=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --migrate-backups) MIGRATE=true ;;
    *) echo "Unknown arg: $arg"; echo "Usage: $0 [--dry-run] [--migrate-backups]"; exit 2 ;;
  esac
done

# Keep this many newest local backups during --migrate-backups (6 hourly + newest daily
# is enforced hourly by backup-db.mjs; the one-time migration just needs a safe floor).
LOCAL_KEEP="${BACKUP_LOCAL_KEEP:-7}"

say() { echo "[reclaim] $*"; }
run() { if [ "$DRY_RUN" = true ]; then echo "  DRY-RUN would: $*"; else eval "$*"; fi; }

df_line() { df -h "$DATA_DIR" 2>/dev/null | awk 'NR==2 {print "  "$3" used, "$4" free ("$5" full)"}'; }

OFFLOAD_CONFIGURED=false
if [ -n "${SPACES_BUCKET:-}" ] && [ -n "${SPACES_KEY:-}" ] && [ -n "${SPACES_SECRET:-}" ] && [ -n "${SPACES_ENDPOINT:-}" ] && command -v s3cmd >/dev/null 2>&1; then
  OFFLOAD_CONFIGURED=true
fi
s3_flags() {
  echo "--access_key=${SPACES_KEY} --secret_key=${SPACES_SECRET} --host=${SPACES_ENDPOINT} --host-bucket=%(bucket)s.${SPACES_ENDPOINT}"
}

say "Data dir: $DATA_DIR"
say "Before:"; df_line
[ "$DRY_RUN" = true ] && say "DRY-RUN mode — no changes will be made"

# --- Step 1: stray one-off DB copies ---------------------------------------
say "Step 1: stray DB copies"
shopt -s nullglob
STRAYS=( "${DATA_DIR}"/portal.db.bak-precancel-* "${DATA_DIR}"/portal.db.pre-restore )
FOUND_STRAY=false
for f in "${STRAYS[@]}"; do
  [ -e "$f" ] || continue
  FOUND_STRAY=true
  SZ=$(du -h "$f" | cut -f1)
  if [ "$DRY_RUN" = true ]; then
    say "  would remove $(basename "$f") ($SZ)"
  else
    rm -f "$f"
    say "  removed $(basename "$f") ($SZ)"
  fi
done
[ "$FOUND_STRAY" = false ] && say "  none found"

# --- Step 2: compress existing uncompressed backups ------------------------
say "Step 2: compress uncompressed backups"
FOUND_UNCOMPRESSED=false
if [ -d "$BACKUP_DIR" ]; then
  for f in "${BACKUP_DIR}"/portal-*.db; do
    [ -e "$f" ] || continue
    # Never touch the live DB (defensive — it lives in DATA_DIR, not backups/).
    [ "$f" = "$DB_PATH" ] && continue
    FOUND_UNCOMPRESSED=true
    if [ "$DRY_RUN" = true ]; then
      echo "  DRY-RUN would: gzip $(basename "$f") -> $(basename "$f").gz (mtime preserved)"
      continue
    fi
    # gzip, preserve original mtime on the .gz, verify, then remove the original.
    gzip -c "$f" > "$f.gz"
    touch -r "$f" "$f.gz"
    if gzip -t "$f.gz" 2>/dev/null; then
      rm -f "$f" "$f-wal" "$f-shm"
      say "  compressed $(basename "$f")"
    else
      rm -f "$f.gz"
      say "  WARNING: verify failed for $(basename "$f") — left uncompressed"
    fi
  done
fi
[ "$FOUND_UNCOMPRESSED" = false ] && say "  nothing to compress"

# --- Step 3: migrate to Space (optional) -----------------------------------
if [ "$MIGRATE" = true ]; then
  say "Step 3: migrate backups to Space"
  if [ "$OFFLOAD_CONFIGURED" != true ]; then
    say "  Space not configured (SPACES_* + s3cmd) — skipping upload/prune (compress-only)."
  else
    # Upload every local .db.gz (idempotent overwrite), then verify listing.
    for f in "${BACKUP_DIR}"/portal-*.db.gz; do
      [ -e "$f" ] || continue
      name="$(basename "$f")"
      run "s3cmd put '$f' 's3://${SPACES_BUCKET}/${name}' $(s3_flags) >/dev/null"
      say "  uploaded $name"
    done

    # Confirm what's actually in the Space before pruning anything.
    if [ "$DRY_RUN" = true ]; then
      say "  DRY-RUN would: prune local backups beyond newest $LOCAL_KEEP (only if confirmed in Space)"
    else
      mapfile -t IN_SPACE < <(s3cmd ls "s3://${SPACES_BUCKET}/" $(s3_flags) 2>/dev/null | grep -oE 'portal-[^/[:space:]]+\.db\.gz$' || true)
      declare -A SPACE_SET
      for n in "${IN_SPACE[@]}"; do SPACE_SET["$n"]=1; done

      # Newest-first by filename (ISO timestamp), keep the newest $LOCAL_KEEP,
      # delete the rest ONLY when confirmed present in the Space.
      mapfile -t LOCAL_SORTED < <(cd "$BACKUP_DIR" && ls -1 portal-*.db.gz 2>/dev/null | sort -r)
      idx=0
      pruned=0
      for name in "${LOCAL_SORTED[@]}"; do
        idx=$((idx+1))
        [ "$idx" -le "$LOCAL_KEEP" ] && continue
        if [ -n "${SPACE_SET[$name]:-}" ]; then
          rm -f "${BACKUP_DIR}/${name}"
          pruned=$((pruned+1))
        else
          say "  keeping $name (not yet confirmed in Space)"
        fi
      done
      say "  pruned $pruned local backup(s); kept newest $LOCAL_KEEP"
    fi
  fi
fi

say "After:"; df_line
if [ "$DRY_RUN" = true ]; then
  say "Done (dry-run — nothing changed)."
else
  say "Done."
fi
