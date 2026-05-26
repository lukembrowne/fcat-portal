# Spec: Disk-bounded (chunked) image download for ML processing

**Status:** Draft for implementation
**Branch to use:** `fix/ml-chunked-download` (already created off `origin/main`)
**Author context:** Written after the 2026-05-25 production disk-full outage. See memory `incident-disk-full-biochoco-download` for the incident itself.

---

## 1. Background — what happened

On 2026-05-25 the production droplet's root disk (193 GB) hit **100% full**, which broke nginx (502s) and degraded every container on the box. Root cause: a BioChoco ML processing job (`biochoco_processing_jobs` id 341, deployment 131) tried to download **all 3,973 full-res stills (~81 GB)** from Google Drive into `data/cache/ct-images/131/` **before** running ML. 81 GB did not fit in ~75 GB free → `ENOSPC` → the portal container crashed.

It then **crash-looped**: on boot `recoverStuckJobs()` (`src/db/index.ts:173`) resets `processing` jobs to `pending`, and `processNextInQueue()` re-claims the job, which re-starts the 81 GB download from scratch → fills disk → crashes → repeats.

The outage was resolved by stopping the portal, clearing the cache, marking job 341 `cancelled` (a terminal status that won't resume), and `docker compose up -d --force-recreate portal`. **Deployment 131 still cannot be processed** until the download is made disk-bounded.

### Key facts discovered (verify before relying on them)
- The active pipeline writes to **`biochoco_*`** tables. The Drizzle objects `schema.processingJobs` / `schema.images` / `schema.deployments` **map to `biochoco_processing_jobs` / `biochoco_images` / `biochoco_deployments`**. The same-named SQL tables (`processing_jobs`, `images`, `deployments`) are unused legacy with 0 rows. (Memory: `gotcha-camera-trap-tables-empty-biochoco-active`.)
- Full-res images live in `data/cache/ct-images/{deploymentId}/`; thumbnails in `data/thumbnails/{deploymentId}/`; both on the host bind-mount `data/`.

---

## 2. Problem statement

The ML job runner downloads an **entire deployment's** full-res images up front, so **peak disk usage = the whole deployment** (81 GB for dep 131). There is a cache cap but it does **not** help:

- `CT_IMAGE_CACHE_MAX_GB` (default **30 GB**) drives `evictIfOverLimit()` (`src/lib/drive-downloader.ts:467`), which evicts *other* deployments' caches to stay under the cap — but line **508** explicitly **skips the deployment currently being downloaded**. So the active deployment downloads its full size regardless of the cap. **Lowering `CT_IMAGE_CACHE_MAX_GB` does not prevent the outage.**

When the download exceeds free disk, the filesystem fills to 100%, which crashes not just the job but the whole server (and every co-tenant container).

---

## 3. Current architecture (with exact references)

### Entry / queue
- Boot hook `src/instrumentation.ts` → `recoverStuckJobs()` (`src/db/index.ts:173`, resets `processing`→`pending`) → `processNextInQueue()`.
- Queue runner `src/lib/job-queue.ts:134 processNextQueueable()` picks the oldest `pending` queueable job, atomically claims it (`pending`→`processing`), and `dispatchClaimedJob()` (`:191`) routes ML jobs to `processJobInternal(jobId)`.

### The runner — `src/app/camera-trap/actions.ts:314 processJobInternal(jobId)`
Phases in order:
1. **Setup / claim / fetch deployment** (314–375). `checkCancelled()` (370) = job no longer `processing`.
2. **Image download** (376–407): `downloadDeploymentForProcessing(deploymentId, jobId, onProgress, checkCancelled)`.
3. **Video download** (409–439): `downloadVideosForProcessing(...)`.
4. **Fail-if-nothing** (441–466): if no images and no videos and deployment had images → fail.
5. **Frame extraction** (468–693): for each video needing extraction → `extractFrames()` writes frame JPEGs **into `cacheDir`**, inserts `images` rows (`videoId`, `frameIndex`, status `pending`), generates frame thumbnails, then **uploads frames to Drive** (`uploadFramesToDrive`, 642) so each frame gets a `driveFileId`, then **deletes the local source videos** (673–682). Updates job `extractedFrames` + `totalImages` (686–692).
6. **Zombie check** (696–700): bail if job externally killed.
7. **Optional `compressFirst`** (702–739): compress uncompressed cached JPEGs in place + upload to Drive (`compressImageBatch`).
8. **Zombie check** (741–745).
9. **Re-fetch `jobImages`** (747–751). Empty → complete (753–781).
10. **ML availability check** (783–820): `checkPytorchWildlife()`.
11. **ML run** (822–850): filters to `pendingImages` (status `pending`), calls `runMLPredictions(jobId, { imagePaths: [...], ... })`.
12. **Finalize** (864–893): set job `completed`/`failed`, emit terminal event, set deployment `processed`/`scanned`.
13. **Catch** (908–953): on any throw → job `failed` + errorMessage, deployment reverted to `scanned`, queue advanced. **This is why a thrown guard error fails cleanly and does not resume** (failed is terminal).

### `src/lib/drive-downloader.ts`
- `downloadDeploymentForProcessing()` (`:73`): `evictIfOverLimit()` → query `images` for deployment → filter safe filename (`isSafeCacheFilename`) + per-file size cap (`MAX_FILE_SIZE_BYTES` = 100 MB) → split `alreadyCached` vs `toDownload` → **Pre-flight summary log with `downloadSizeMb`** (158–168) → `downloadDeploymentImages()` → write `images.path` (204–213) → generate thumbnails (215–254).
- `downloadDeploymentImages()` (`src/lib/drive-client.ts:635`): batches of 50, `Promise.all` per batch, retries once per file (`downloadFile`), logs `"[Drive] Batch complete"`.
- `evictIfOverLimit()` (`:467`): LRU-by-mtime eviction of *other* deployment dirs to stay under `CT_CACHE_MAX_BYTES`; nulls `images.path` for evicted deployments (proxy falls back to Drive).

### ML runner — `src/lib/ml-runner.ts`
- **Persistent model server** (`spawnModelServer`, `ensureModelServer` `:690`, PID file `data/model-server.pid`, idle timer). Model loads once and stays warm; an idle timeout shuts it down. **Calling `runMLPredictions` repeatedly reuses the warm server** — per-chunk calls do NOT reload the model.
- `runMLPredictions(jobId, config)` (`:771`): builds `path→imageId` from `images WHERE jobId`, ensures the server, sends `{ image_paths, confidence_threshold, batch_size, num_workers }` over stdin, resolves with `{ success, totalProcessed, totalDetections, error }`. **It does NOT finalize the job** — the caller does. So it is safe to call once per chunk.
- As the server processes each image it **inserts `detections` (`:452`) + `identifications` (`:467`) and marks the image `status:"processed"` (`:483`)** and bumps job progress (`:492`). Results are persisted per-image, independent of whether the full-res file stays on disk.

### Why deleting full-res after ML is safe
Detections/identifications key off image IDs; thumbnails are separate files in `data/thumbnails/`; the image proxy (`/api/ct-images/[id]`) falls back to Drive for full-res when `images.path` is null. So after a chunk is ML'd, its full-res cache files can be deleted and `images.path` nulled with no data loss.

---

## 4. Goals

1. **Never fill the disk.** A job must not push the filesystem toward 100%.
2. **Hybrid behavior (explicit user request):** if the whole deployment's pending download fits within free disk (minus a safety margin), keep the current efficient bulk path; otherwise process in **chunks** (download a chunk → ML → delete chunk) so peak disk ≈ one chunk.
3. **Cover video deployments too**, not just image-only ones.
4. **Preserve all existing semantics:** incremental jobs (`ml_incremental`), resume after crash, cancellation, zombie checks, progress/status messages, terminal events, deployment status transitions.
5. **Fail fast & cleanly** when even a single chunk + margin cannot fit (e.g., disk genuinely too small) — a clean Spanish job failure, not a crash.

---

## 5. Proposed solution

Deliver in **two parts**. Part A is small, safe, and independently shippable; it is the "gate" of the hybrid and stops the outage from recurring for *every* deployment. Part B is the larger chunking refactor.

### Part A — Pre-flight disk guard (do first, ship independently)

Add to `src/lib/drive-downloader.ts`:
- `DISK_MARGIN_BYTES` from `CT_PROCESS_DISK_MARGIN_GB` (default 20 GB).
- `getFreeDiskBytes(): Promise<number>` using `fs.statfs(process.cwd())` → `bavail * bsize`. Fail-open (return `Infinity` + warn) if statfs throws — statfs is reliable on Linux; we don't want to block all processing if measurement fails. (Consider fail-closed if you prefer safety over availability.)
- A **pure, unit-testable** helper: `assessDiskCapacity(pendingBytes, freeBytes, marginBytes = DISK_MARGIN_BYTES): { fits: boolean; pendingBytes; freeBytes; marginBytes }`.
- An exported `InsufficientDiskError` (or just throw `Error` with a Spanish message).

Wire into `downloadDeploymentForProcessing()` right after the pre-flight summary (after `:168`, before the download at `:174`): compute `freeBytes = await getFreeDiskBytes()`; if `downloadSize > 0 && !assessDiskCapacity(downloadSize, freeBytes).fits` → `throw new InsufficientDiskError(...)` with a message like:
`"Espacio en disco insuficiente: la descarga requiere ~81 GB pero solo hay ~75 GB libres (margen ${MARGIN} GB). Procese menos imágenes o amplíe el disco."`

The existing catch (`actions.ts:908`) turns this into a clean `failed` job + deployment `scanned`. **Net effect:** the 81 GB job fails immediately with a clear message instead of crash-looping the server.

**Tests (Vitest):** `assessDiskCapacity` truth table (fits / exactly-at-margin / over); `getFreeDiskBytes` returns a positive number on the test host. (The guard inside `downloadDeploymentForProcessing` is DB+Drive-bound — cover it via the pure helper, not an integration test.)

### Part B — Chunked download→ML→delete (the real fix)

**Core idea (unifies images + video frames):** by ML time, *every* image row has a `driveFileId` — stills from scanning, and extracted frames after `uploadFramesToDrive`. So full-res files can be fetched **on demand per chunk** and deleted after ML. This lets us bound peak disk for both stills and frames with one mechanism.

Decision at the start of the image phase:
- `pendingBytes` = sum of not-yet-cached drive-backed image sizes (already computed as `downloadSize`).
- `freeBytes = getFreeDiskBytes()`.
- If `assessDiskCapacity(pendingBytes, freeBytes).fits` → **bulk path** (current behavior, unchanged).
- Else → **chunked path**.
- If even `CHUNK_TARGET_BYTES + DISK_MARGIN_BYTES > freeBytes` (or a single file > free) → fail fast (Part A guard semantics).

**Chunk grouping:** group drive-backed image rows so each chunk's cumulative `file_size` (use a fallback, e.g. 20 MB, for null/0 sizes) ≤ `CHUNK_TARGET_BYTES` from `CT_PROCESS_CHUNK_MAX_GB` (default 10 GB).

**Chunked loop (per chunk):**
1. `checkCancelled()` → break.
2. Download just this chunk's missing files; write `images.path`; generate thumbnails for the chunk. (Factor the existing download+path+thumbnail body of `downloadDeploymentForProcessing` into a reusable `downloadImageSet(cacheDir, deploymentId, jobId, rows, onProgress, isCancelled)` so both bulk and chunked paths share it.)
3. `runMLPredictions(jobId, { imagePaths: <chunk paths>, ... })` — warm model server; persists detections + marks images `processed`.
4. Delete the chunk's full-res files + null their `images.path` (keep thumbnails + detections). New helper `releaseChunkFiles(rows)`.
5. Accumulate `totalProcessed`/`totalDetections`; update `downloadedImages`/`processed`/`statusMessage`.

After the loop, finalize exactly as the current single-pass path (status, terminal event, deployment status).

**Video frames in chunked mode:** frame extraction (phase 5) already uploads frames to Drive and gets `driveFileId`. To bound frame disk too, after upload **delete local frame files and null their `images.path`**, then let the unified chunked ML pass re-download them on demand (they're grouped into chunks like any other image). This re-downloads frames we just created — accept the cost for bounded disk, OR (optimization) only release frame locals when `!fits`. For the bulk path, leave frames on disk as today.

**Refactor shape (suggested):**
- `downloadDeploymentForProcessing` keeps its signature for the bulk path; internally delegates to `downloadImageSet`.
- New `processDeploymentImagesChunked(deployment, job, { onProgress, checkCancelled })` that owns the chunk loop and calls `runMLPredictions` per chunk. `processJobInternal` chooses bulk vs chunked after computing the disk assessment, and **skips the single ML block (822–850) when chunked** (it already ran ML per chunk).
- Keep `compressFirst` correct: in chunked mode, compression must happen per chunk **before** ML+delete (download chunk → compress+upload → ML → delete), or document that `compressFirst` + chunked is unsupported and fail fast. Decide explicitly.

---

## 6. Config knobs (env)
- `CT_PROCESS_DISK_MARGIN_GB` (default 20) — free-disk headroom required.
- `CT_PROCESS_CHUNK_MAX_GB` (default 10) — target bytes per chunk in chunked mode.
- (Existing) `CT_IMAGE_CACHE_MAX_GB` (default 30) — unchanged; note it does NOT gate the active deployment.
- Consider a kill-switch `CT_PROCESS_CHUNKING_ENABLED` (default true) to fall back to bulk+guard if chunking misbehaves in prod.

---

## 7. Pitfalls / edge cases (read carefully)

1. **`schema.*` ↔ `biochoco_*` mapping.** All `images`/`processingJobs` references in this code path hit the `biochoco_*` tables. Don't be fooled by empty `processing_jobs`/`images` SQL tables.
2. **`better-sqlite3` transactions are synchronous** — never `db.transaction(async …)`. Use sequential `await db.update(...)` for async work. (Project-wide gotcha.)
3. **Drive calls need `supportsAllDrives: true` / `includeItemsFromAllDrives: true`** or they silently return empty. `downloadFile`/`downloadDeploymentImages` already do; preserve this.
4. **Cancellation mid-chunk.** Check `checkCancelled()` between chunks (and ideally the existing isCancelled inside `downloadDeploymentImages`). A cancelled job must leave already-processed images with their detections intact and not be resumed (it's terminal).
5. **Resume after crash.** `recoverStuckJobs()` resets `processing`→`pending` and (for camera-trap job types) resets non-`processed` images to `pending`, nulling paths under `/tmp/ct-job-`. Chunked mode nulls `images.path` for *processed* chunks too (after delete) — ensure resume re-downloads only `pending` images and does NOT re-run ML on already-`processed` ones (the current ML block already filters to `pending`; keep that).
6. **Frame re-download vs. waste.** Releasing frame locals to re-download them costs Drive bandwidth + time. Only do it on the `!fits` path.
7. **`compressFirst` + chunked.** Compression rewrites cached files in place and re-uploads; it assumes files are present. Either thread it per-chunk or fail fast when both are set. Don't silently skip compression.
8. **Thumbnails must be generated before deleting full-res** (they derive from it). The chunk loop must thumbnail before release.
9. **`evictIfOverLimit` interaction.** In chunked mode we self-bound, but eviction of *other* deployments at the start is still fine. Don't let eviction null the path of the deployment we're actively chunking (it already skips the current deployment).
10. **statfs measures the filesystem, not the cache dir quota.** `data/` is a host bind-mount on the root fs; `process.cwd()` is on the same fs. Fine on this droplet; revisit if `data/` is ever moved to a separate volume (then statfs the cache path).
11. **Disk used by co-tenants.** Free disk is shared with ~20 other containers. The 20 GB margin protects them; don't shrink it casually.
12. **Idempotency / double-claim.** `processJobInternal` has existing idempotency + zombie checks; keep them around the chunk loop.
13. **Progress UX contract.** Project convention requires determinate progress + ETA + status messages for background jobs. Preserve `downloadedImages`/`download_total`/`statusMessage` updates so the floating progress UI keeps working in chunked mode.

---

## 8. Testing strategy
- **Unit (Vitest):** `assessDiskCapacity` truth table; chunk-grouping function (sizes → chunks ≤ target, handles null sizes via fallback, single-oversize behavior); `getFreeDiskBytes` returns positive.
- **Integration (mock DB + mock Drive):** chunked path downloads → ML → releases per chunk; processed images keep detections; `images.path` nulled after release; resume skips processed images.
- **Manual on a scratch deployment:** a deployment larger than `CHUNK_MAX_GB` but smaller than disk; confirm peak `data/cache/ct-images` stays ≈ one chunk via `watch du -sh`.
- **Guard:** force `CT_PROCESS_DISK_MARGIN_GB` huge so any job fails fast; confirm clean `failed` status + Spanish message + deployment `scanned` + no crash.
- Re-run the existing camera-trap/processing test suite; nothing should regress on the bulk path.

---

## 9. Rollout
1. Land Part A (guard) first; deploy; verify a deliberately-too-big job fails cleanly.
2. Land Part B behind `CT_PROCESS_CHUNKING_ENABLED`; test on a scratch deployment; then re-run deployment 131 (currently job 341 `cancelled`) to validate end-to-end.
3. Update `CLAUDE.md` (camera-trap/ML section) and the incident memory once shipped.

---

## 10. Out of scope (note for the operator)
- Resizing the droplet / attaching a DigitalOcean block-storage volume for `data/` is a complementary infra fix (193 GB is tight when single deployments are ~80 GB) but is independent of this code change.
- The legacy unused `processing_jobs`/`images`/`deployments` SQL tables are not touched here.
