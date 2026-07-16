---
title: "fix: Resolve and prevent production disk-full blocking camera-trap ML jobs"
date: 2026-07-12
type: fix
status: ready
depth: standard
---

# fix: Resolve and prevent production disk-full blocking camera-trap ML jobs

## Summary

The production droplet's root disk is 90% full (173 G of 193 G used, ~21 G free). The camera-trap ML pre-flight guard refuses any job that can't reserve one chunk (~10 G) plus the 20 G co-tenant safety margin — ~30 G free. With only ~21 G free, every nightly job fails immediately (`0 / N`, "Fallido", *Espacio en disco insuficiente*). Five deployments failed on the 2026-07-11 nightly run (GIZ-011_V1, NAC-004_V1, POT-002_V1, POT-004_V1, POT-008_V1).

This plan has two parts: **(1)** a one-time reclaim (~45 G) to unblock the queue tonight, and **(2)** structural changes so the disk stops creeping back to full — gzip-compressed backups, an independent orphaned-cache sweep, and a proactive disk alert that fires *before* jobs hit the guard. No droplet resize (decision: stay on 193 G; resize is documented as a fallback lever, not planned work).

> **Implementation status (2026-07-13):** Shipped and active — **gzip compression** (backups 38 G → ~11 G, retention unchanged at 48h hourly + 7 daily), the **orphaned-cache sweep**, and the **low-disk alert**. The **DigitalOcean Space offload is built but deferred** — it ships behind `BACKUP_OFFLOAD_ENABLED` (default **off**), so backups stay entirely on the droplet for now. It is a **future lever**: when disk pressure returns, provision the Space, set the `SPACES_*` env vars, and flip the flag — no code changes required (steps in `docs/operations/disk-space-runbook.md`). The offload sections below (U2 offload path, U3 auto-pull, U6 migration, U8 provisioning) describe that dormant machinery, not shipped-and-configured behavior.

---

## Problem Frame

**Where the space goes** (`/root/opt/fcat-portal/data` = 92 G of the 173 G used):

| Consumer | Size | Nature |
|---|---|---|
| `data/backups/` | 38 G | 54 backups × ~710 MB, **uncompressed**, all local. Retention (48h hourly + 7 daily) works as designed; the DB grew to 710 MB so the footprint ballooned. Target after this plan: ~1.5 G local (6 hourly + newest daily, gzipped), full history in a Space. |
| `data/cache/ct-images/` | 30 G | At the `CT_IMAGE_CACHE_MAX_GB=30` cap. 25 G is deployment 107, 4.6 G is 467, both last touched Jul 11 — **orphaned** from a failed/stuck run (chunked processing deletes full-res after each chunk, so a completed job leaves ~0). |
| `data/thumbnails/` | 15 G | Needed, persistent (image-proxy fallback). |
| `ml-cache` / `models` / `ml-venv` / `training-exports` | ~9.5 G | Needed. |
| Stray DB copies | 0.2 G | `data/portal.db.bak-precancel-1779750931` (202 M, May 25 cancel incident) + `data/portal.db.pre-restore` (11 M, Feb 15). Safe to delete. |
| Docker reclaimable (outside `data/`) | ~30 G | build cache 10.2 G (0 active), dangling images 8 G, unused volumes 12.7 G. |

**Why it can't self-heal.** `evictIfOverLimit()` (`src/lib/drive-downloader.ts:798`) is the *only* code path that trims the cache, and it has two properties that combine into a deadlock here:

1. It runs **only when a download starts** (called at `drive-downloader.ts:231`). Every job now fails at the pre-flight guard *before* the download, so eviction never fires.
2. Even when it does fire, it evicts only down to `CT_CACHE_MAX_BYTES` (30 G) and **skips the active deployment** (`drive-downloader.ts:839`). It maintains the cap; it never frees disk *below* the cap under pressure.

So the orphaned 30 G sits resident indefinitely, directly competing with the 30 G-free the guard demands. Clearing it manually unblocks tonight, but without an independent sweep the same orphan can recur after any future stuck/cancelled job.

**Scope note.** This is a co-tenant droplet (`/root/opt/central` = ODK Central, `fcat-choconexion`, `ChocoForestWatch`, others). The 20 G guard margin protects those containers — the 2026-05-25 disk-full outage took down ODK Central's Postgres. **Do not shrink the margin.** All reclaim here targets *portal-owned* space and safe Docker reclaimables.

---

## Requirements

- **R1** — Free enough disk that free space clears the ~30 G guard threshold with real headroom (target: recover ~45 G, reaching ~65 G free / ~66% used), so the failed nightly deployments reprocess.
- **R2** — Cut the backup footprint via gzip compression, preserving restore integrity.
- **R3** — Offload backups to a DigitalOcean Space (S3-compatible): every backup is uploaded; only the last 6 hourly + newest daily stay local (~1.5 G). The Space holds the long-term history. **A backup is never deleted locally until its upload is confirmed** (write-then-prune).
- **R4** — Restore transparently handles local *and* Space-only backups: `restore-db.sh` lists both and auto-pulls a Space-only file when selected.
- **R5** — Clear orphaned `ct-images` cache directories automatically (no active/pending job), independent of the download-triggered eviction path, so a stuck job can't strand disk again.
- **R6** — Emit a proactive alert (system event + surfaced in the daily email) when free disk drops below a warning threshold, *before* jobs hit the hard guard.
- **R7** — No change to the guard margin, chunk logic, or co-tenant protections. Restore must remain correct for legacy (`.db`), gzipped (`.db.gz`), local, and Space-only backups. Offload is feature-flagged so the portal runs unchanged until the Space + credentials exist.

---

## Key Technical Decisions

- **KTD1 — Gzip backups.** Each backup compresses ~710 MB → ~200 MB (SQLite pages compress ~3.5×). Gzip shrinks both the local footprint and every Space upload/download. Restore must transparently decompress.
- **KTD2 — Offload to a DigitalOcean Space, keep a tiny local window (built, DEFERRED).** *Deferred 2026-07-13 — see the implementation-status note above. Backups stay on the droplet for now; this is the re-enable path when space is tight again.* Upload every backup to an S3-compatible Space; keep only the last 6 hourly + newest daily local (~1.5 G). Local backups would drop from 38 G to ~1.5 G — a bigger, more durable win than gzip alone (~11 G). **Ordering is safety-critical: upload + verify, then prune local — never prune a backup that isn't confirmed in the Space** (mirrors the codebase's write-then-clear Sheets pattern). Long-term expiry is a Space lifecycle rule, decoupled from the local window. *Cost note (revisited 2026-07-13): with a pre-existing Spaces subscription this bucket is marginal per-GiB, and since the droplet already has daily DR backups it only needs short retention — at which point plain **Standard** storage at short/thinned retention is cheapest (well under $1/mo) and avoids Cold Storage's 30-day-minimum penalty. Revisit the storage class at enable time.*
- **KTD3 — Dependency-safe upload via a CLI binary (`s3cmd`), not an npm SDK.** The prod runner is a pruned `.next/standalone` image; an untraced npm dep like `@aws-sdk/client-s3` risks being pruned (per the untraced-modules learning). `python3` is already in the runner and `s3cmd` is apt-installable — add it to the existing runner apt line. The backup script (plain `.mjs`) shells out to `s3cmd`, matching the curl-based cron style. Alternative considered: `rclone` (single binary, nicer sync) — viable, but `s3cmd` is lighter given python3 is present.
- **KTD4 — No droplet resize.** Stay on 193 G; reclaim + offload provide ample headroom. Resize is documented in the runbook as a ready-to-pull lever (steps + threshold) if disk creeps back despite the fixes — not planned work.
- **KTD5 — Independent cache sweep, not a change to `evictIfOverLimit`.** The eviction function's contract (maintain the cap, skip the active deployment, run on download) is correct for its job and should not be overloaded. Add a *separate* sweep that reclaims cache dirs with no active or pending processing job. Reuse the existing "is there an active audio/ML job" locking primitives to decide what's safe to delete.
- **KTD6 — Reuse `getFreeDiskBytes()` and the existing cron+email plumbing for the alert.** `getFreeDiskBytes()` (`drive-downloader.ts:174`, fail-closed) already measures free disk. Model the alert on `shared-drive-alerts` (cron route → `recordEvent()` → surfaced in the nightly email), rather than inventing new infrastructure.
- **KTD7 — Feature-flag the offload** (`BACKUP_OFFLOAD_ENABLED`, default off). Until the Space + credentials are provisioned, the backup script behaves as gzip-local-only. Flip on after the Space exists — same discipline as the shared-drive rollout flags.

---

## Implementation Units

### U1. Immediate one-time disk reclaim (operational)

**Goal:** Free ~45 G on prod now so the guard clears and the failed nightly deployments reprocess. This is an operational runbook executed against the server, plus a small idempotent helper for the safe, repeatable parts.

**Requirements:** R1

**Dependencies:** none (can run before the code units ship; U2/U6 make the backup win durable)

**Files:**
- `scripts/reclaim-disk.sh` (new) — idempotent helper for the *safe* reclaim steps: delete the two stray DB copies, gzip existing uncompressed backups in `data/backups/`, print a `df -h /` before/after. A `--dry-run` flag lists actions without executing. Does **not** run `docker system prune` or delete cache (those stay operator-driven and are documented in the runbook).
- `docs/operations/disk-space-runbook.md` (new) — the full reclaim + recovery runbook (see U7).

**Approach:** Ordered reclaim, largest safe wins first:
1. Delete stray DB copies (`portal.db.bak-precancel-*`, `portal.db.pre-restore`) — ~0.2 G.
2. `docker system prune -f` (build cache + dangling images) — ~18 G safe; **not** `--volumes` (12.7 G of volumes need per-volume verification first — list with `docker volume ls -f dangling=true` and confirm none belong to a live app before pruning).
3. Clear the orphaned cache: confirm deployments 107 and 467 have no active job, then remove `data/cache/ct-images/107` and `.../467` and null the corresponding `images.path` rows (the image proxy falls back to Drive) — ~30 G. **This is exactly what U4 automates**; do it manually once here.
4. Compress existing backups (via `reclaim-disk.sh` or U6's script) — ~28 G.
Steps 1+2+3 alone clear the guard; step 4 makes the durable structural win visible immediately.

**Patterns to follow:** cache-path nulling mirrors `evictIfOverLimit` (`drive-downloader.ts:844-856`); disk measurement via `df -h /`.

**Test scenarios:**
- `reclaim-disk.sh --dry-run` on a copy of the data dir lists the stray files and uncompressed backups it *would* act on, and exits 0 without modifying anything.
- `reclaim-disk.sh` deletes only files matching the stray-copy globs and gzips only `portal-*.db` (never `portal-*.db.gz`, never the live `portal.db`).
- Re-running `reclaim-disk.sh` a second time is a no-op (idempotent — nothing left to compress or delete).

**Verification:** `df -h /` on the droplet shows free disk ≥ ~55 G (used ≤ ~72%); the five failed deployments succeed on the next nightly run (or a manual reprocess), reaching `N / N` Completado.

---

### U2. Gzip + offload backups to the Space, keep a tiny local window

**Goal:** Every new backup is compressed, uploaded to the Space, and then pruned locally down to the last 6 hourly + newest daily — with upload confirmed *before* any local prune.

**Requirements:** R2, R3, R7

**Dependencies:** U8 (Space, credentials, `s3cmd` in the image, `BACKUP_OFFLOAD_ENABLED`)

**Files:**
- `scripts/backup-db.mjs` (modify)

**Approach:** After the SQLite online backup writes `portal-<ts>.db` and passes `integrity_check` (`backup-db.mjs:82-107`), gzip it to `portal-<ts>.db.gz` and remove the uncompressed `.db` (integrity check stays on the *uncompressed* file — compress only after "ok"). Then, when `BACKUP_OFFLOAD_ENABLED` is true:
1. Upload the `.db.gz` to the Space via `s3cmd put` (creds from env — see U8). Verify the upload (`s3cmd info` / non-zero exit handling); on failure, record an error event and **skip local pruning** so nothing is lost — the file simply stays local until a later run succeeds.
2. Rewrite `cleanupOldBackups()` (`backup-db.mjs:136-187`) into a **local-window** policy: keep the newest 6 hourly `.db.gz` + the newest daily `.db.gz`; delete older *local* files **only if confirmed present in the Space** (`s3cmd info`, or trust the just-succeeded upload for the current file + a listing check for older ones). Still tolerate/prune legacy `.db` and their `-wal`/`-shm` sidecars during transition; guard sidecar cleanup to `.db`-only.

When `BACKUP_OFFLOAD_ENABLED` is false, fall back to the gzip-local-only path with a conservative local retention (e.g. 48h) so a mis-set flag never deletes history that isn't offloaded. Record uploaded/compressed `sizeBytes` and offload status in the `cron_db_backup` event. Long-term Space expiry is a lifecycle rule (U8), not this script's job.

**Patterns to follow:** stream `createGzip` for the 710 MB file (bound memory); `execFileSync("s3cmd", [...])` for uploads; write-then-clear ordering (upload-verify-then-prune) mirrors the Sheets save pattern; preserve `recordEventSql` events. Feature-flag discipline mirrors `SHARED_DRIVE_*` flags.

**Test scenarios:**
- Happy path (offload on): valid DB → `.db.gz` produced, uploaded (mocked `s3cmd`), local files pruned to 6 hourly + newest daily; the `.gz` decompresses to a DB passing `integrity_check`.
- **Upload fails → no local prune.** `s3cmd put` returns non-zero → error event recorded, the local `.db.gz` is retained (and so are older local files), exit reflects the failure. Nothing is deleted that isn't in the Space.
- Retention window: a `backups/` fixture with 20 hourly `.db.gz` (all confirmed in Space) prunes to the newest 6 + newest daily locally; older ones remain in the Space (not re-deleted there).
- Offload off (flag false): gzip-only, conservative local retention applied, no `s3cmd` calls.
- Edge: integrity check fails on the uncompressed backup → `.db` removed, no `.gz`, no upload, error event, exit 1.
- Edge: legacy `.db` + stale `-wal`/`-shm` pruned with sidecars; `.db.gz` pruned without sidecar handling.

**Verification:** After one cron cycle on prod (flag on), `ls data/backups/` shows ≤7 `*.db.gz` (~1.5 G), `s3cmd ls s3://<bucket>/` shows the uploaded backup, and the `cron_db_backup` event reports offload success + compressed size.

---

### U3. Restore handles compressed + Space-only backups (auto-pull)

**Goal:** `restore-db.sh` restores from local `.db.gz`/legacy `.db` *and* backups that live only in the Space, auto-downloading the selected one when it isn't local.

**Requirements:** R2, R4, R7

**Dependencies:** U2 (`.db.gz` format), U8 (Space + `s3cmd` + creds)

**Files:**
- `scripts/restore-db.sh` (modify)

**Approach:** Build the candidate list from two sources: local `portal-*.db.gz`/`portal-*.db` (as today, `restore-db.sh:35`) **and**, when offload creds are present, `s3cmd ls s3://<bucket>/` — merged, de-duplicated by filename, newest-first, with a marker showing whether each is local or Space-only. On selection, if the file is Space-only, `s3cmd get` it into a temp path first. In the restore step (`:126-127`): if the resolved file ends in `.gz`, `gunzip -c > "$DB_PATH"`; else `cp`. Keep the pre-restore safety copy (`:120-123`), WAL/SHM removal (`:130`), and recovery hint (`:146-147`) unchanged. `restore-db.sh latest` picks the newest across both sources. Degrade gracefully when creds are absent (local-only listing, today's behavior).

**Patterns to follow:** existing branch structure + `set -e`; `s3cmd get`/`ls` for the Space; decompress-to-temp before overwriting `portal.db` so a bad download never clobbers the live DB.

**Test scenarios:**
- Restore a Space-only `.db.gz`: selecting it downloads via `s3cmd get`, decompresses into `data/portal.db`, pre-restore copy created, portal restarts and passes startup integrity check.
- Restore a local `.db.gz`: no download, decompress + restore.
- Restore a legacy local `.db` (back-compat): plain `cp`, unchanged.
- `restore-db.sh latest` picks the newest file across local + Space.
- Space-only download fails (network/creds) → aborts before touching `portal.db`; live DB intact.
- No creds configured → local-only listing, no `s3cmd` calls (graceful degrade).

**Verification:** On prod, `./scripts/restore-db.sh` lists both local and Space backups; selecting an older Space-only one restores it and the portal comes back healthy. (Test against a scratch `DATA_DIR`, not live.)

---

### U4. Independent orphaned-cache sweep

**Goal:** Reclaim `ct-images/{id}` directories that have no active or pending processing job, independent of the download-triggered eviction, so a stuck/cancelled job can't strand disk.

**Requirements:** R5

**Dependencies:** none (complements, does not modify, `evictIfOverLimit`)

**Files:**
- `src/lib/drive-downloader.ts` (modify) — add `sweepOrphanedCache()` exported alongside `evictIfOverLimit`.
- `src/app/api/cron/disk-maintenance/route.ts` (new) — cron entry that calls the sweep (and hosts the U5 alert).
- `scripts/crontab` (modify) — schedule the new route.
- `src/lib/system-events.ts` (modify) — add the event type/label if the sweep emits a summary event.
- Test: `src/lib/drive-downloader.test.ts` (new or extend existing drive-downloader tests).

**Approach:** For each directory under `data/cache/ct-images/`, resolve its deployment id and check whether that deployment has an active or pending camera-trap/audio job. Reuse `findActiveAudioJob` / the camera-trap job-lock primitives (`src/lib/job-locks.ts`) and the `CAMERA_TRAP_ML_JOB_TYPES` filter so the sweep never deletes cache under a live or queued job. For orphans, delete the directory and null the matching `images.path` rows (mirror `evictIfOverLimit:844-856`). Emit one summary `recordEvent()` at the end (count + bytes reclaimed) — batch, not per-directory, per the system-events convention. Run it from the new cron on a schedule (e.g. daily, before the nightly batch) and once opportunistically. Unlike `evictIfOverLimit`, this is **not** gated on the 30 G cap — an orphan is reclaimable at any size because nothing is using it.

**Patterns to follow:** `evictIfOverLimit` for directory sizing + path-nulling; `recoverStuckJobs` for the "is this job still live" reasoning; `job-locks.ts` for the active-job check; `reconcile-shared-drives` route for the cron-route + Bearer-auth shape (no XFF guard — see the `gotcha_cron_xff_guard_403s_in_container` learning).

**Execution note:** Guard deletion behind the active-job check first, test-first — deleting cache under a running job would corrupt an in-flight run.

**Test scenarios:**
- Orphan reclaimed: a cache dir for a deployment with no jobs is deleted and its `images.path` rows nulled.
- Active job protected: a cache dir for a deployment with a pending or processing ML/audio job is **not** touched.
- Integration: after sweeping an orphan, the image proxy still serves those images via the Drive fallback (path is null, not broken).
- Edge: a cache dir whose name isn't a valid deployment id, or an empty dir, is skipped without error.
- Edge: sweep on an empty/absent `ct-images/` returns cleanly (mirrors `evictIfOverLimit`'s readdir guard).

**Verification:** Manually stranding a throwaway cache dir (no job) and running the cron route reclaims it and logs a summary event; a dir under an active job survives.

---

### U5. Proactive free-disk alert

**Goal:** Warn *before* jobs hit the hard guard, so the disk squeeze is caught while there's still slack.

**Requirements:** R6

**Dependencies:** U4 (shares the `disk-maintenance` cron route)

**Files:**
- `src/app/api/cron/disk-maintenance/route.ts` (modify — same route as U4, sweep then check)
- `src/lib/system-events.ts` (modify) — add a `disk_space_low` event type + label.
- Nightly email surface (modify) — the daily BioChoco email folds in a disk-health line when the event is warn/critical (mirror how shared-drive capacity surfaces).
- Test: route test alongside U4.

**Approach:** After the sweep, call `getFreeDiskBytes()`. Compare against two env-configurable thresholds — e.g. `DISK_WARN_FREE_GB` (default ~45, comfortably above the 30 G guard need) and `DISK_CRITICAL_FREE_GB` (default ~32, just above the guard). Below warn → `recordEvent()` severity `warning`; below critical → `error`. Fail-closed: if `getFreeDiskBytes()` returns `null` (statfs glitch), emit a warning event ("could not measure free disk") rather than staying silent. Surface the most recent warn/critical event as a line in the daily email. No new email cron — reuse the existing daily send.

**Patterns to follow:** `shared-drive-alerts` route (threshold → event → email); `getFreeDiskBytes` fail-closed semantics (`drive-downloader.ts:174`); `recordEvent`/`JOB_LABELS` conventions in `system-events.ts`.

**Test scenarios:**
- Free disk below warn but above critical → one `disk_space_low` warning event, no error.
- Free disk below critical → error-severity event; email includes the disk-health line.
- Free disk healthy → no event emitted (silent, like shared-drive-alerts).
- `getFreeDiskBytes()` returns null → warning event about the measurement failure (fail-closed).
- Thresholds honor env overrides (`DISK_WARN_FREE_GB` / `DISK_CRITICAL_FREE_GB`).

**Verification:** Temporarily set `DISK_WARN_FREE_GB` above current free disk on prod → the next cron run records a warning event and the daily email shows the disk-health line; reset the threshold and the alert goes silent.

---

### U6. One-time migration of existing backups (compress → upload → prune local)

**Goal:** Apply the win immediately to the 54 already-uncompressed backups: compress them, push them all to the Space, then prune local down to the 6-hourly + newest-daily window.

**Requirements:** R1, R2, R3

**Dependencies:** U2 (`.db.gz` naming), U8 (Space + `s3cmd` + creds)

**Files:**
- Folded into `scripts/reclaim-disk.sh` (U1) — a `--migrate-backups` step. Listed as its own unit for traceability; no separate file.

**Approach:** For each `data/backups/portal-*.db` (skipping already-`.gz`), gzip to `portal-<ts>.db.gz` preserving mtime (`touch -r`), verify, remove the original. Then `s3cmd put` every `.db.gz` to the Space and verify. Only after uploads are confirmed, prune local to the last 6 hourly + newest daily. Idempotent and safe to re-run: skips already-compressed files, re-uploads are harmless overwrites, and prune only removes files confirmed in the Space. Requires the Space to exist (U8) — until then, `reclaim-disk.sh` compresses locally only (the ~28 G gzip win still lands; offload follows once the Space is up).

**Patterns to follow:** same naming/format U2/U3 expect; upload-verify-then-prune ordering (never prune an un-uploaded file).

**Test scenarios:**
- A dir of uncompressed `portal-*.db` → all become `portal-*.db.gz` (mtime preserved), all uploaded (mocked `s3cmd`), local pruned to 6 hourly + newest daily; each survivor decompresses to a DB passing `integrity_check`.
- Upload of one file fails → that file (and older ones) stay local; no data lost.
- Re-run is a no-op (nothing left to compress; prune already at the window).
- Space not yet provisioned → compress-only, no prune (offload deferred).

**Verification:** Post-run `du -sh data/backups/` ≈ 1.5 G, `s3cmd ls s3://<bucket>/` lists the full set, and `restore-db.sh latest` (U3) restores from the newest compressed file.

---

### U8. Provision the Space, credentials, and `s3cmd` in the image

> **DEFERRED (2026-07-13).** Not executed. The `s3cmd` image install and the `SPACES_*`/`BACKUP_OFFLOAD_ENABLED` env plumbing shipped (dormant, flag off); the operator steps below — creating the Space, keys, and lifecycle rule — are the re-enable checklist for when disk pressure returns.

**Goal:** Stand up the S3-compatible bucket and the in-container tooling/credentials the backup + restore scripts depend on, behind the offload feature flag.

**Requirements:** R3, R7

**Dependencies:** none (blocks U2/U3/U6 offload behavior; those degrade to gzip-local-only until this lands)

**Files:**
- `Dockerfile` (modify) — add `s3cmd` to the runner apt line (`Dockerfile:73-75`), alongside `python3`/`cron`.
- `docker-compose.yml` / server `.env` + `/etc/cron.d/portal-env` (modify) — add `BACKUP_OFFLOAD_ENABLED`, `SPACES_ENDPOINT`, `SPACES_REGION`, `SPACES_BUCKET`, `SPACES_KEY`, `SPACES_SECRET`. The hourly backup cron already sources `portal-env`, so `s3cmd` picks creds up there.
- `.env.example` (modify) — document the new vars (values blank).
- `docs/operations/disk-space-runbook.md` (U7) — the operator provisioning steps.

**Approach (operator + config):**
1. Create a DigitalOcean Space (e.g. `fcat-portal-backups`, private ACL, nearest region) and a Spaces access key/secret. Operator action — documented in U7.
2. Set a **lifecycle rule** on the Space to expire old objects (recommend keep ~30–90 daily, then delete) so long-term storage stays bounded and cheap.
3. Add `s3cmd` to the runner image; supply creds via env. `s3cmd` reads `--access_key/--secret_key/--host` flags or a generated `~/.s3cfg`; the scripts pass the DO Spaces endpoint (`SPACES_ENDPOINT`, e.g. `<region>.digitaloceanspaces.com`).
4. Keep `BACKUP_OFFLOAD_ENABLED=false` until the Space + creds are verified in-container, then flip to `true`.

**Patterns to follow:** feature-flag rollout mirrors `SHARED_DRIVE_DISCOVERY_ENABLED`/`SHARED_DRIVE_ROUTING_ENABLED` (default off, flip after infra exists); secret handling mirrors existing container env secrets (`CRON_SECRET`); Dockerfile apt-line extension mirrors the existing runner deps.

**Test scenarios:**
- `Test expectation: none (infra/config)` — verified operationally: `docker compose build` succeeds with `s3cmd` present; in-container `s3cmd ls s3://<bucket>/` authenticates and lists; a manual `s3cmd put` of a scratch file round-trips.
- Flag off → backup/restore make no `s3cmd` calls (covered by U2/U3 tests).

**Verification:** Inside the container, `s3cmd ls s3://<bucket>/` succeeds; a test `put`/`get` round-trips; the lifecycle rule is visible in the DO console.

---

### U7. Operations runbook

**Goal:** Document the incident, the reclaim sequence, the Space provisioning, the recurring maintenance, and the resize fallback lever.

**Requirements:** R1, R2, R3 (documentation)

**Dependencies:** U1–U6, U8 (documents what they do)

**Files:**
- `docs/operations/disk-space-runbook.md` (new)

**Approach:** Capture: the failure signature (guard message, `df` reading); the ordered reclaim (U1) with the co-tenant-safe caveats (no `--volumes` without per-volume check, don't shrink the margin); the **Space provisioning** steps (create Space + key, lifecycle rule, env vars, flip `BACKUP_OFFLOAD_ENABLED`) from U8; the new maintenance surfaces (offloaded gzip backups + local window, cache sweep cron, disk alert + thresholds); how to restore from a Space-only backup (U3); and the **droplet-resize fallback** — the exact DigitalOcean steps and trigger condition (disk creeps back above ~85% despite the fixes) so it's a ready lever per KTD4. Cross-reference the `incident_disk_full_biochoco_download` learning and the 2026-05-25 co-tenant outage.

**Test scenarios:** `Test expectation: none` — documentation. Reviewed for accuracy against U1–U6.

**Verification:** A reader can execute the reclaim and the resize fallback from the runbook without reading the code.

---

## System-Wide Impact

- **Co-tenant containers** (ODK Central, ChocoForestWatch, etc.) benefit from the freed disk and the earlier-warning alert; the guard margin that protects them is untouched.
- **Backup/restore workflow**: `.db` → `.db.gz` + Space offload changes where backups live (last 6 hourly + newest daily local, rest in the Space) and the restore UX (auto-pull). Restore stays backward-compatible with legacy local `.db` (U3). Documented in U7; CLAUDE.md Backups section update is a follow-up.
- **New external dependency**: the DigitalOcean Space. Backups now depend on Spaces availability and valid creds. Mitigated by write-then-prune (a failed upload keeps the file local) and the feature flag (offload can be disabled to fall back to gzip-local-only).
- **New cost**: DO Spaces (~$5/mo base, 250 G included). Small and expected.
- **Cron surface**: one new route (`disk-maintenance`) on the existing Bearer-auth, no-XFF-guard pattern.

---

## Scope Boundaries

**In scope (shipped):** one-time reclaim; gzip backups (retention unchanged at 48h hourly + 7 daily); independent cache sweep; proactive disk alert; ops runbook.

**Built but deferred (2026-07-13):** the DigitalOcean Space offload — upload path, auto-pull restore, one-time migration, and `s3cmd`/env provisioning — all behind `BACKUP_OFFLOAD_ENABLED` (default off). Backups stay on the droplet; re-enable when space is tight again (runbook has the checklist). See the implementation-status note in the Summary.

**Deferred to Follow-Up Work:**
- Update the CLAUDE.md **Backups** section to mention the `.db.gz` format.
- Consider lowering `CT_IMAGE_CACHE_MAX_GB` or making eviction disk-pressure-aware (not just cap-aware) — a deeper change to `evictIfOverLimit` beyond this fix.
- Thumbnail growth (15 G, growing) — a separate retention/eviction question, not touched here.

**Out of scope (decided):**
- Droplet resize — documented as a fallback lever (KTD2), not planned work.
- Any change to the guard margin, chunk size, or chunked-processing logic.

---

## Risks & Dependencies

- **Deleting cache under a live job** (U1 step 3, U4) would corrupt an in-flight run. Mitigation: active-job check before every deletion; U1 step 3 is done manually with deployments 107/467 confirmed idle.
- **`docker system prune --volumes`** could delete a co-tenant's data volume. Mitigation: runbook forbids `--volumes` without a per-volume `docker volume ls -f dangling=true` review.
- **Compressing the live `portal.db`** by accident would break the DB. Mitigation: `reclaim-disk.sh` globs only `portal-*.db` in `backups/`, never the live DB; explicit exclusion + test.
- **Memory during compression** of the 710 MB backup. Mitigation: stream via `createGzip`, don't buffer the whole file.
- **Pruning a backup that isn't in the Space** would lose history. Mitigation (load-bearing): strict upload-verify-then-prune ordering in U2/U6; a failed/unverified upload leaves the file local. Tested explicitly ("upload fails → no local prune").
- **Spaces outage or bad creds** could stall offload. Mitigation: failed uploads keep files local (disk grows temporarily, caught by the U6 disk alert) rather than losing data; `BACKUP_OFFLOAD_ENABLED=false` reverts to gzip-local-only.
- **npm S3 SDK pruned from the standalone image** (the untraced-modules gotcha). Mitigation: use `s3cmd` CLI in the runner image (KTD3), not an npm dep.
- **Spaces credentials in container env** — secrets. Mitigation: handle like `CRON_SECRET`; private-ACL bucket; never commit real values (`.env.example` blank).
- **Dependency order:** U8 (Space + `s3cmd` + creds) blocks U2/U3/U6 *offload* behavior — but those degrade to gzip-local-only without it, so U2/U3 and the ~28 G gzip reclaim can ship first and offload can flip on once U8 lands. U2 defines the `.db.gz` format U3/U6 match. U4/U5 (sweep, alert) are independent and can land in parallel.

---

## Sources & Research

- Live prod investigation (2026-07-12): `df -h`, `du` breakdown of `data/`, `docker system df`, backup count/sizes, cache dir ownership (dep 107/467).
- `src/lib/drive-downloader.ts` — guard (`:42`, `:174`, `:201`, `:324`), eviction (`:798-856`), chunk/cache env knobs (`:34-50`).
- `scripts/backup-db.mjs` — backup + `cleanupOldBackups` (`:136-187`); `scripts/restore-db.sh`; `scripts/crontab`.
- `Dockerfile` — runner stage is pruned `.next/standalone` (`:68-93`), apt install line (`:73-75`) where `s3cmd` is added; confirmed no existing S3/Spaces usage in the repo.
- DigitalOcean Spaces: S3-compatible object storage, `s3cmd`-driven; lifecycle rules for long-term expiry.
- Memory: `incident_disk_full_biochoco_download`, `incident_odk_central_postgres_down_after_disk_full`, `gotcha_cron_xff_guard_403s_in_container`, `incident_cancelqueue_clobbers_deployment_status` (a cancel path is a plausible origin of the 107/467 orphan).
