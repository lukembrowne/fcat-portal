# Disk-Space Runbook

How to recognize, reclaim, and prevent a full root disk on the production droplet — the condition that makes camera-trap ML jobs fail at the pre-flight guard.

Related: [`incident_disk_full_biochoco_download`], the 2026-05-25 co-tenant outage (ODK Central Postgres died on disk-full). Plan: `docs/plans/2026-07-12-001-fix-production-disk-full-plan.md`.

---

## Failure signature

Nightly camera-trap jobs fail immediately (`0 / N`, **Fallido**) with:

> Espacio en disco insuficiente: la descarga requiere ~X GB pero solo hay ~Y GB libres (margen 20.0 GB).

The pre-flight guard (`src/lib/drive-downloader.ts`) needs **one chunk (~10 GB) + the 20 GB co-tenant margin ≈ 30 GB free**. If free disk is below that, every job is refused before it downloads anything. Confirm with:

```bash
ssh digitalocean "df -h /"          # Use% at/over 90% is the red flag
```

**Do NOT shrink the 20 GB margin** (`CT_PROCESS_DISK_MARGIN_GB`). It protects the co-tenant containers (ODK Central + its Postgres, ChocoForestWatch, etc.). The 2026-05-25 outage is what happens when the shared disk fills.

---

## Where the space goes

```bash
ssh digitalocean "du -h -d2 /root/opt/fcat-portal/data | sort -rh | head -20"
ssh digitalocean "docker system df"
```

Typical large consumers: `data/backups/` (DB backups), `data/cache/ct-images/` (ML working cache, capped at `CT_IMAGE_CACHE_MAX_GB`), `data/thumbnails/` (persistent, needed), and Docker reclaimables (build cache, dangling images, unused volumes).

---

## Immediate reclaim (unblock jobs now)

Run the safe, idempotent steps via the helper first, then the operator-only steps.

### 1. Safe reclaim (helper script)

```bash
# From inside the container (has s3cmd + the SPACES_* env if offload is configured):
docker compose exec -T portal ./scripts/reclaim-disk.sh --dry-run   # preview
docker compose exec -T portal ./scripts/reclaim-disk.sh             # delete strays + gzip backups
docker compose exec -T portal ./scripts/reclaim-disk.sh --migrate-backups  # + upload to Space, prune local
```

This deletes stray one-off DB copies (`portal.db.bak-precancel-*`, `portal.db.pre-restore`) and gzips existing backups. It never touches the live `data/portal.db`. `--migrate-backups` uploads every backup to the Space and prunes local **only after** each upload is confirmed.

### 2. Docker prune (operator — review first)

```bash
ssh digitalocean "docker system df"        # see what's reclaimable
ssh digitalocean "docker system prune -f"  # build cache + dangling images (safe)
```

**Never** run `docker system prune --volumes` blindly — a co-tenant app's data volume could be caught. Review first:

```bash
ssh digitalocean "docker volume ls -f dangling=true"   # confirm none belong to a live app, THEN prune specific ones
```

### 3. Orphaned ML cache (operator — confirm idle, or let the cron do it)

Cache under `data/cache/ct-images/{deploymentId}` left by a failed/cancelled run can hold tens of GB. The daily `disk-maintenance` cron sweeps these automatically (see below). To do it manually, confirm the deployment has **no active/pending job**, then remove its dir:

```bash
# Check for an active job for the deployment before deleting its cache dir.
ssh digitalocean "du -h -d1 /root/opt/fcat-portal/data/cache/ct-images | sort -rh | head"
# After confirming idle:
ssh digitalocean "rm -rf /root/opt/fcat-portal/data/cache/ct-images/<id>"
```

The image proxy falls back to Drive, so deleting cache is safe (the deployment just re-downloads if reprocessed).

---

## Structural prevention (already in the codebase)

### Compressed, offloaded backups

- `scripts/backup-db.mjs` gzips each hourly backup (~710 MB → ~200 MB) and, when `BACKUP_OFFLOAD_ENABLED=true`, uploads it to a DigitalOcean Space and keeps only the **last 6 hourly + newest daily** locally (~1.5 GB). Upload is verified **before** any local prune — a failed upload keeps the file on disk.
- Restore (`scripts/restore-db.sh`) lists local **and** Space backups and auto-downloads a Space-only file when selected.

### Provisioning the Space (one-time)

1. In the DigitalOcean console, create a **Space** (e.g. `fcat-portal-backups`, **private** ACL, nearest region) and generate a **Spaces access key + secret**.
2. Add a **lifecycle rule** on the Space to expire old objects (recommend keeping ~30–90 daily, then delete) so long-term storage stays bounded.
3. Set these in the server `.env` (see `.env.example`), then redeploy so the entrypoint forwards them to the backup cron:

   ```
   BACKUP_OFFLOAD_ENABLED=true
   SPACES_ENDPOINT=<region>.digitaloceanspaces.com
   SPACES_REGION=<region>
   SPACES_BUCKET=fcat-portal-backups
   SPACES_KEY=<access key>
   SPACES_SECRET=<secret key>
   ```

4. Verify inside the container before trusting it:

   ```bash
   docker compose exec portal s3cmd ls "s3://$SPACES_BUCKET/" \
     --access_key="$SPACES_KEY" --secret_key="$SPACES_SECRET" \
     --host="$SPACES_ENDPOINT" --host-bucket="%(bucket)s.$SPACES_ENDPOINT"
   ```

   Keep `BACKUP_OFFLOAD_ENABLED=false` until this authenticates; until then the backup runs gzip-local-only.

### Restore from a Space-only backup

```bash
docker compose exec portal ./scripts/restore-db.sh          # lists local + Space, marks each
docker compose exec portal ./scripts/restore-db.sh latest   # newest across both
```

### Daily disk-maintenance cron

`/api/cron/disk-maintenance` (10:30 PM Eastern, before the 11 PM nightly batch):

1. Sweeps orphaned `ct-images` cache (dirs with no active/pending job).
2. Emails a low-disk alert when free disk drops below the warn threshold — **before** jobs hit the guard. Silent when healthy.

Thresholds (env, GB): `DISK_WARN_FREE_GB` (default 45), `DISK_CRITICAL_FREE_GB` (default 32). Recipients: `DISK_ALERT_EMAILS` (falls back to `PORTAL_UPDATES_EMAILS`). Events are recorded to `system_events` (visible at `/admin/activity`) regardless of email.

---

## Fallback lever: resize the droplet

The current plan keeps the droplet at 193 GB and relies on reclaim + offload. **If disk still creeps back above ~85% despite the fixes** (check `df -h /` and the disk-maintenance alerts), resize:

1. DigitalOcean console → the droplet → **Resize** → choose a disk-inclusive plan (a bigger disk requires a plan with more disk; CPU/RAM-only resizes are reversible, disk resizes are **not**).
2. Power off when prompted, resize, power on. Expect a short maintenance window.
3. After boot, confirm `df -h /` shows the larger disk and the co-tenant containers came back up (`docker ps`, and check ODK Central specifically — its Postgres has no restart policy).

Prefer this only after the structural fixes are confirmed working and the disk is still tight — it costs more per month and the disk grow is one-way.
