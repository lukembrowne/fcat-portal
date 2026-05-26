---
title: "Disk-bounded (chunked) image download for ML processing"
type: fix
date: 2026-05-26
branch: fix/ml-chunked-download
spec: docs/plans/ml-chunked-download-spec.md
incident: memory/incident_disk_full_biochoco_download.md
revision: v2 (post plan-review — DHH / Kieran / Simplicity)
---

# 🐛 fix: Disk-bounded (chunked) image download for ML processing

> **Implementation plan** derived from `docs/plans/ml-chunked-download-spec.md`. All
> `file:line` references were re-verified against the current tree on 2026-05-26.
> Delivered in two independently-shippable parts: **Part A** (pre-flight disk guard)
> stops the outage for every deployment; **Part B** (chunked download→ML→delete)
> lets too-big deployments actually succeed.

> **v2 revisions after multi-agent review.** Folded in: statfs **fail-closed** (was
> fail-open, which recreated the outage); **C1** cumulative progress across per-chunk
> ML calls (the ML runner resets `processedCount` to 0 each call → bar ran backward);
> **H3** a real `computePendingDownload()` helper (the bulk/chunked decision needs
> `pendingBytes`, which did not exist at the `actions.ts` call site); **C3** an
> in-scope `recoverStuckJobs` dangling-path fix; **M3** eviction in the chunked path;
> **M4** explicit finalize-status derivation; and `assessDiskCapacity` simplified to a
> boolean. The `CT_PROCESS_CHUNKING_ENABLED` kill-switch is **kept** (reframed as an
> emergency lever) per the decision to ship full Part B against the disk that caused a
> major outage; reviewers' caveat is recorded.

## Overview

A BioChoco ML job downloads an **entire deployment's** full-res stills before running
ML. On 2026-05-25 deployment 131 (3,973 stills, ~81 GB) overflowed the 193 GB
droplet's free disk → `ENOSPC` → portal crash → crash-loop (boot recovery re-claimed
the job and re-started the 81 GB download). nginx 502'd, co-tenant containers
degraded, and ODK Central's Postgres died (`incident_odk_central_postgres_down_after_disk_full`).

- **Part A — Pre-flight disk guard** (ship first): measure free disk before
  downloading; if pending + margin won't fit, fail the job cleanly with a Spanish
  message. **This alone closes the outage** — it converts the crash into a clean
  `failed` job via the existing catch.
- **Part B — Chunked download → ML → delete**: when the whole deployment won't fit,
  loop chunk-by-chunk so peak disk ≈ one chunk. Keep the bulk path when it fits.

## Problem Statement

`downloadDeploymentForProcessing()` downloads every drive-backed image before ML, so
**peak disk = whole deployment**. The cache cap does **not** help: `evictIfOverLimit()`
(`drive-downloader.ts:467-543`) evicts *other* deployments but `:508`
(`if (dir.name === String(currentDeploymentId)) continue;`) **skips the active one**.
When the download exceeds free disk the filesystem hits 100%, crashing the job **and
the whole server** (shared root fs with ~20 other containers).

## Proposed Solution

### Why chunked deletion is safe (verified)

By ML time **every** image row has a `driveFileId` — stills from scanning, frames
after `uploadFramesToDrive` (`actions.ts:642`). Per-image results survive deletion:
`runMLPredictions` persists `detections` (`ml-runner.ts:451`) + `identifications`
(`:466`) and marks the image `status:"processed"` (`:481-484`) **as each image is
processed**. Thumbnails live in `data/thumbnails/`. The proxy
(`api/ct-images/[id]/route.ts:136-173`) falls back to Drive when `images.path` is null
or the cache file is missing (**verified: the fallback keys off `image.driveFileId`**).
So after a chunk is ML'd we delete its full-res files and null `images.path` with no
data loss.

### Verified architecture map (current line numbers)

| Component | Location | Notes |
|---|---|---|
| Boot recovery → queue | `src/instrumentation.ts:14-22` | `recoverStuckJobs()` then `processNextInQueue()` |
| Stuck-job recovery | `src/db/index.ts:173-267` | resets `processing`→`pending` (`:194-204`); for camera-trap (`:212`) resets non-`processed` images→`pending`, nulls path **only if it contains `/tmp/ct-job-`** (`:219-231`) ⚠️ Part B fixes this |
| Queue dispatch | `src/lib/job-queue.ts:191-267` | ML + ML_INCREMENTAL → `processJobInternal(job.id)` (`:193-197`) |
| **Job runner** | `src/app/camera-trap/actions.ts:314-954` | phase map below |
| Image download | `src/lib/drive-downloader.ts:73-262` | `downloadDeploymentForProcessing(deploymentId, jobId, onProgress?, isCancelled?)`; eviction `:85`; query `:91-96`; safe/size filter `:114-135`; cached-vs-toDownload split **by fs existence** `:142-154`; pre-flight `downloadSize` `:164`; download call `:181`; write path `:205-213`; thumbnails `:215-254` |
| Batch downloader | `src/lib/drive-client.ts:606-658` | `BATCH_SIZE=50`, `isCancelled` `:622-625`, `onProgress(downloaded, failed, total)` `:654` |
| Eviction | `src/lib/drive-downloader.ts:467-543` | skips current deployment `:508` |
| ML runner | `src/lib/ml-runner.ts:771-852` | warm server (`ensureModelServer` `:690`, 10-min idle, PID `data/model-server.pid`); per-image persist `:451-494`; **re-inits `processedCount:0` each call** `:828-838` (C1); writes **absolute** `processedImages` `:491-492`; does NOT finalize job |
| Progress UI | `src/components/floating-job-progress.tsx:188-217` | `% = processed/total`, ETA from `processed/elapsed` — both key off `processedImages`/`totalImages` |
| Compression | `src/app/camera-trap/drive-actions.ts:423-520` | `compressImageBatch` rewrites file in place + `images.fileSize` `:517`; falls back to Drive if cache missing `:460-463` |

**`processJobInternal` phase map (verified):** (1) setup/`checkCancelled` `337-374`;
(2) image download `368-407`; (3) video download `409-439`; (4) fail-if-nothing
`441-466`; (5) frame extraction `468-693` (`uploadFramesToDrive` `642`, delete videos
`673-682`); (6) zombie `696-700`; (7) `compressFirst` `702-739`; (8) zombie `741-745`;
(9) re-fetch/empty→complete `747-781`; (10) ML availability `783-820`; (11) ML run
(filter `pending`) `822-850`; (12) finalize `864-893`; (13) catch `908-953`.

**Progress UX contract (must preserve):** `onProgress` writes per phase — `preflight`
→ `cachedImages`/`downloadTotal`/`statusMessage`; `downloading` → `downloadedImages`/
`statusMessage`; `thumbnails` → `statusMessage` (`actions.ts:382-403`).

---

## Part A — Pre-flight disk guard (ship first, independently)

### A1. Disk helpers in `src/lib/drive-downloader.ts`

```ts
import { statfs } from "node:fs/promises"; // Node 22

const DISK_MARGIN_BYTES =
  parseInt(process.env.CT_PROCESS_DISK_MARGIN_GB || "20", 10) * 1024 * 1024 * 1024;

/**
 * Free bytes on the cache filesystem, or `null` if it cannot be measured.
 * FAIL-CLOSED (review M1): callers treat `null` as "don't risk a bulk download".
 * statfs returning null must NEVER permit an unbounded bulk download — that is the
 * exact branch that recreated the outage.
 */
export async function getFreeDiskBytes(): Promise<number | null> {
  try {
    const s = await statfs(process.cwd()); // data/ bind-mounts on root fs; see Pitfall 10
    return s.bavail * s.bsize;
  } catch (err) {
    log.warn({ err }, "[drive-downloader] statfs failed → treating disk as unmeasurable");
    return null;
  }
}

/** Pure boolean (review: dropped the echoed-inputs object). */
export function diskFits(
  pendingBytes: number,
  freeBytes: number,
  marginBytes: number = DISK_MARGIN_BYTES,
): boolean {
  return pendingBytes + marginBytes <= freeBytes;
}

export class InsufficientDiskError extends Error {
  constructor(pendingBytes: number, freeBytes: number, marginBytes = DISK_MARGIN_BYTES) {
    const gb = (b: number) => (b / 1024 / 1024 / 1024).toFixed(1);
    super(
      `Espacio en disco insuficiente: la descarga requiere ~${gb(pendingBytes)} GB ` +
      `pero solo hay ~${gb(freeBytes)} GB libres (margen ${gb(marginBytes)} GB). ` +
      `Procese menos imágenes o amplíe el disco.`,
    );
    this.name = "InsufficientDiskError";
  }
}
```

### A2. Wire the guard into the bulk download

After the pre-flight summary (`drive-downloader.ts:164`), before `downloadDeploymentImages` (`:181`):

```ts
const free = await getFreeDiskBytes();
// free === null (unmeasurable) → fail-closed: refuse the unbounded bulk download.
if (downloadSize > 0 && (free === null || !diskFits(downloadSize, free))) {
  throw new InsufficientDiskError(downloadSize, free ?? 0);
}
```

The existing catch (`actions.ts:908-953`) turns the throw into `failed` job +
`scanned` deployment + advanced queue. (Once Part B lands, this guard moves into the
`computePendingDownload`-driven decision in §B3; for a standalone Part A ship it lives
here.)

### A3. Tests (Part A) — `tests/unit/lib/drive-downloader-disk-guard.test.ts`

- `diskFits` truth table: fits, exact boundary (`pending+margin === free` → true), over → false, `pending=0`.
- `getFreeDiskBytes()` returns a finite positive number on the test host.
- **statfs fail-closed (M1):** mock `statfs` to throw → `getFreeDiskBytes()` returns
  `null`; assert the guard throws `InsufficientDiskError` (never proceeds).
- `InsufficientDiskError` message is Spanish and includes GB figures.

### A4. Part A acceptance

- [x] `getFreeDiskBytes` (returns `number | null`), `diskFits`, `InsufficientDiskError` exported + unit-tested.
- [x] Guard throws before any bytes downloaded when `pending+margin > free` **or disk unmeasurable**.
- [x] Too-big job (e.g. `CT_PROCESS_DISK_MARGIN_GB=10000`) → `failed` + Spanish message, deployment `scanned`, **no crash**. (Guard throws `InsufficientDiskError`; existing runner catch at `actions.ts:908-953` handles it. Wired into both image and video download paths.)
- [x] Bulk path unchanged when it fits; existing camera-trap tests pass (97 related tests green).

---

## Part B — Chunked download → ML → delete

### B1. Config

```ts
const CHUNK_TARGET_BYTES =
  parseInt(process.env.CT_PROCESS_CHUNK_MAX_GB || "10", 10) * 1024 * 1024 * 1024;
const CHUNKING_ENABLED = (process.env.CT_PROCESS_CHUNKING_ENABLED ?? "true") !== "false";
const NULL_SIZE_FALLBACK_BYTES = 20 * 1024 * 1024; // plain const (review): null/0 file_size fallback
```

| Env | Default | Meaning |
|---|---|---|
| `CT_PROCESS_DISK_MARGIN_GB` | 20 | free-disk headroom (Part A + per-chunk gate; protects co-tenants) |
| `CT_PROCESS_CHUNK_MAX_GB` | 10 | target bytes per chunk; an operator can lower it under disk pressure without redeploy |
| `CT_PROCESS_CHUNKING_ENABLED` | true | **emergency lever.** `false` → bulk + guard (big deployments fail cleanly). Reviewers (DHH/Simplicity) argued to cut it since "off" == Part A; kept as a no-redeploy off-switch for code touching the disk that caused the outage. Document in CLAUDE.md. |

### B2. `computePendingDownload` — the gate input (review H3 + M3)

The bulk-vs-chunked decision needs the not-yet-cached byte total, which today is
computed *inside* `downloadDeploymentForProcessing` and **not visible to `actions.ts`**.
Extract the eviction + query + filter + existence-split into one helper used by both
paths:

```ts
// src/lib/drive-downloader.ts
export async function computePendingDownload(
  deploymentId: number,
  jobId: number,
): Promise<{ cacheDir: string; rows: ImageRow[]; pendingBytes: number }> {
  await evictIfOverLimit(deploymentId);             // M3: runs for BOTH paths now (was bulk-only)
  // lift current :91-154: query drive-backed images, filter isSafeCacheFilename +
  // MAX_FILE_SIZE_BYTES, split alreadyCached (fs.access exists) vs toDownload.
  // pendingBytes = Σ toDownload file_size (fallback NULL_SIZE_FALLBACK_BYTES).
  return { cacheDir, rows: toDownload, pendingBytes };
}
```

### B3. `downloadImageSet` — shared download primitive

Lift the download+path+thumbnail body (`:181-254`) so bulk and chunked share it. Stays
a pure download primitive (no ML awareness). **Generates thumbnails before returning**
(Pitfall 8 — the chunk loop must never release a chunk before its thumbnails exist).

```ts
export async function downloadImageSet(
  cacheDir: string, deploymentId: number, jobId: number,
  rows: ImageRow[],
  onProgress?: (e: DownloadProgressEvent) => Promise<void>,
  isCancelled?: () => Promise<boolean>,
): Promise<{ downloaded: number; skipped: number; failed: number }>
```

`downloadDeploymentForProcessing` becomes a thin bulk wrapper:
`computePendingDownload` → Part A guard → `downloadImageSet`.

### B4. `groupRowsIntoChunks` — pure, unit-testable

```ts
export function groupRowsIntoChunks(
  rows: ImageRow[],
  chunkTargetBytes = CHUNK_TARGET_BYTES,
  nullSizeFallback = NULL_SIZE_FALLBACK_BYTES,
): ImageRow[][] {
  const chunks: ImageRow[][] = [];
  let cur: ImageRow[] = [], acc = 0;
  for (const r of rows) {
    const size = r.fileSize && r.fileSize > 0 ? r.fileSize : nullSizeFallback;
    if (cur.length && acc + size > chunkTargetBytes) { chunks.push(cur); cur = []; acc = 0; }
    cur.push(r); acc += size;            // single oversize file → its own chunk
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}
```

### B5. ML runner: cumulative progress offset (review C1 — CRITICAL)

`runMLPredictions` re-inits `processedCount: 0` each call and writes the **absolute**
value to `processedImages` (`ml-runner.ts:491-492`). Calling it per chunk makes the
progress bar **reset to 0 each chunk** and the ETA garbage — violating the UX contract
this plan promises. Fix: thread an offset + true total through `MLConfig`, default
to current behavior so the bulk path is unchanged.

```ts
// MLConfig gains (optional):
progressOffset?: number;   // images ML'd in prior chunks
progressTotal?: number;    // total images this job will ML (deployment pending count)

// ml-runner.ts per-image write (:486-494) becomes:
const base = config.progressOffset ?? 0;
const denom = config.progressTotal ?? config.imagePaths.length;
await db.update(processingJobs).set({
  processedImages: base + job.processedCount,
  statusMessage: `Analizando imágenes... (${base + job.processedCount} de ${denom})`,
}).where(eq(processingJobs.id, job.jobId));
```

Add a unit test asserting `processedImages` is **monotonically non-decreasing** across
two simulated chunk calls and ends at `progressTotal`.

### B6. `processDeploymentImagesChunked` — the loop (lives in `actions.ts`)

Per DHH, orchestration of download→ML→delete belongs beside `processJobInternal` in
`actions.ts` (NOT a new `chunked-processor.ts`, NOT inside `drive-downloader.ts`).
The downloader exports the primitives (`computePendingDownload`, `downloadImageSet`,
`groupRowsIntoChunks`, `releaseChunkFiles`, disk helpers); the loop is job-runner work.

```ts
async function processDeploymentImagesChunked(deployment, job, {
  cacheDir, rows, mlConfig, onProgress, checkCancelled,
}): Promise<{ totalProcessed: number; totalDetections: number; cancelled: boolean; anyFailed: boolean }> {
  const chunks = groupRowsIntoChunks(rows);
  const pendingTotal = rows.length;              // C1 denominator (this job's ML total)
  let totalProcessed = 0, totalDetections = 0, doneCount = 0, anyFailed = false;

  for (const [i, chunk] of chunks.entries()) {
    if (await checkCancelled()) return { totalProcessed, totalDetections, cancelled: true, anyFailed };

    const free = await getFreeDiskBytes();       // recheck each chunk (shared/moving disk)
    const chunkBytes = chunk.reduce((s, r) => s + (r.fileSize || NULL_SIZE_FALLBACK_BYTES), 0);
    // free === null (unmeasurable) → DON'T hard-fail; a chunk is bounded (~10 GB).
    // free is a number → enforce the margin (genuinely-0-free correctly throws).
    if (free !== null && !diskFits(chunkBytes, free)) throw new InsufficientDiskError(chunkBytes, free);

    await db.update(processingJobs).set({
      statusMessage: `Procesando lote ${i + 1} de ${chunks.length}...`,
    }).where(eq(processingJobs.id, job.id));

    await downloadImageSet(cacheDir, deployment.id, job.id, chunk, onProgress, checkCancelled);
    if (job.compressFirst) await compressChunk(cacheDir, chunk);     // §B8

    const ml = await runMLPredictions(job.id, {
      ...mlConfig,
      imagePaths: chunk.map(r => cachePathFor(cacheDir, r)),
      progressOffset: doneCount,                 // C1
      progressTotal: pendingTotal,               // C1
    });
    if (!ml.success) anyFailed = true;
    totalProcessed += ml.totalProcessed;
    totalDetections += ml.totalDetections;

    await releaseChunkFiles(chunk);              // delete files + null images.path
    doneCount += chunk.length;
    await db.update(processingJobs).set({ downloadedImages: doneCount })
      .where(eq(processingJobs.id, job.id));
  }
  return { totalProcessed, totalDetections, cancelled: false, anyFailed };
}

// src/lib/drive-downloader.ts — non-atomic by design; made safe by the C3 recovery fix (§B9)
export async function releaseChunkFiles(rows: ImageRow[]): Promise<void> {
  for (const r of rows) {
    if (r.path) { try { await fs.unlink(r.path); } catch { /* already gone */ } }
    await db.update(images).set({ path: null }).where(eq(images.id, r.id)); // sequential await (Pitfall 2)
  }
}
```

### B7. Branch + finalize in `processJobInternal` (review M4)

Replace the image phase + single ML block (`368-407`, `822-850`) with:

```ts
const { cacheDir, rows, pendingBytes } = await computePendingDownload(deployment.id, jobId);
const free = await getFreeDiskBytes();
const fits = free !== null && diskFits(pendingBytes, free);

if (!CHUNKING_ENABLED || fits) {
  // BULK: fail-closed if it doesn't fit and chunking is off
  if (!fits) throw new InsufficientDiskError(pendingBytes, free ?? 0);
  await downloadImageSet(cacheDir, deployment.id, jobId, rows, onProgress, checkCancelled);
  // → phases 9–12 run, INCLUDING the single ML block (filter pending → runMLPredictions)
} else {
  // CHUNKED: ML already runs per chunk; SKIP the single ML block (822-850)
  const r = await processDeploymentImagesChunked(deployment, job, {
    cacheDir, rows, mlConfig, onProgress, checkCancelled,
  });
  // Finalize-status derivation (M4):
  if (r.cancelled) return;                       // job already 'cancelled'; leave it, no terminal event
  const finalStatus = r.anyFailed ? "failed" : "completed";
  // emit ONE terminal event with accumulated totals; set deployment processed/scanned as today
  await emitTerminalEvent({ totalProcessed: r.totalProcessed, totalDetections: r.totalDetections });
  // ...existing finalize (864-893) using finalStatus...
}
```

Keep the ML-availability check (`783-820`) **before** the branch (fail before
downloading if ML is unavailable). Keep zombie checks around the loop.

### B8. Video frames + `compressFirst` (kept per decision; correctness baked in)

- **Frames (B6 of spec):** frame extraction already uploads to Drive (`:642`). In
  **chunked mode only**, after upload delete local frame files and null
  `images.path` so the unified loop re-downloads them on demand (bounded). Leave
  frames on disk for the bulk path (Pitfall 6 — avoid needless re-download). The
  chunk `rows` query is `images WHERE jobId AND status != 'processed' AND driveFileId
  IS NOT NULL`, naturally covering stills + frames.
- **`compressFirst` per-chunk (review H4):** order is download → `compressChunk` → ML
  → release. `compressChunk` selects this chunk's uncompressed JPEGs and calls
  `compressImageBatch`; it rewrites files in place + updates `images.fileSize`
  (`drive-actions.ts:517`). Grouping uses pre-compression sizes (safe over-estimate).
  **Fallback remains available:** if per-chunk compression proves fiddly, fail fast on
  `compressFirst && chunked` with a Spanish message rather than silently skipping.

### B9. In-scope: `recoverStuckJobs` dangling-path fix (review C3/H1/H2)

Releasing files + nulling paths creates a state recovery has never seen: `pending`
rows whose cache files were deleted. `recoverStuckJobs` (`db/index.ts:219-231`) only
nulls paths containing `/tmp/ct-job-`, leaving stale `data/cache/ct-images/...` paths.
The download split re-fetches by **fs existence** (`:142-154`, verified) so download is
safe — but `runMLPredictions` builds its `path→imageId` map from `images.path`
(`ml-runner.ts:776-786`), so a dangling path is a latent hazard. Make this **in-scope**:

```ts
// db/index.ts recoverStuckJobs, camera-trap branch (sync module → fs.existsSync is correct, cf :241)
for (const img of jobImages) {
  if (img.status === "processed") continue;      // resume checkpoint — never re-ML these
  const update: { status: "pending"; path?: null } = { status: "pending" };
  if (img.path && !fs.existsSync(img.path)) update.path = null;   // was: includes("/tmp/ct-job-")
  database.update(schema.images).set(update).where(eq(schema.images.id, img.id)).run();
}
```

**Resume invariant (state it explicitly):** `images.status="processed"`, written
per-image inside the ML runner, is the durable checkpoint. `releaseChunkFiles` is
idempotent and order-independent against it, so a crash before/after release is safe:
on resume, `processed` images are skipped (never re-ML'd, never re-downloaded);
`pending` images with missing files are re-downloaded and ML'd exactly once.

### B10. Tests (Part B)

**Unit:**
- `groupRowsIntoChunks` — sums ≤ target per chunk; null/0 → fallback; single oversize → own chunk; empty → `[]`.
- **C1 progress monotonicity** — two chunk calls with `progressOffset`/`progressTotal`: assert `processedImages` non-decreasing across the boundary and final == `progressTotal`.

**Integration** (in-memory DB: `tests/helpers/test-db.ts` `createTestDb`/`setupIntegrationDbMock`/`testDbRef`; mock Drive + `runMLPredictions` as `camera-trap-jobs.test.ts` does):
- Chunked path: each chunk download → ML → `releaseChunkFiles`; `images.path` null after release; detections/identifications survive.
- **Finalize status (M4):** chunk 2 ML returns `success:false` → job `failed`; cancel after chunk 1 → job stays `cancelled`, no terminal event, chunk-1 detections intact.
- **Dangling-path resume (C3/H3):** seed a `pending` row with `path:'/data/cache/ct-images/131/x.jpg'` whose file does NOT exist → assert `recoverStuckJobs` nulls it, then it's re-downloaded and ML'd; a `processed` row is never re-ML'd.
- **Bulk regression:** when it fits, `processDeploymentImagesChunked` is not called; single ML block runs.

**Manual (scratch deployment > `CHUNK_MAX_GB`, < disk):** `watch du -sh
data/cache/ct-images/{id}` stays ≈ one chunk; job `completed`, detections present,
full-res deleted, thumbnails intact, progress bar advances monotonically.

### B11. Part B acceptance

- [x] Hybrid: fits → unchanged bulk path; doesn't → chunks. `CHUNKING_ENABLED=false` → bulk + guard (clean fail). (`actions.ts` decision after `assessPendingStillDownload`.)
- [ ] Peak `data/cache/ct-images/{id}` ≈ one chunk (manual `du` — prod/scratch verification, see Rollout step 2).
- [x] **Progress bar monotonic across chunks**; `processedImages` ends == total; ETA sane (C1). (ML runner `progressOffset`/`progressTotal`; unit-tested in `chunked-image-processor.test.ts`.)
- [x] Per-chunk: download → (optional compress) → ML → release; detections persisted before release. (Loop in `chunked-image-processor.ts`; `compressFirst` runs in the existing pre-ML phase before the chunked pass.)
- [x] Eviction runs for the chunked path (M3 — explicit `evictIfOverLimit(deploymentId)` at the start of `processDeploymentImagesChunked`, frees other deployments' caches; chunked self-bounds its own footprint per chunk); video deployments bounded (frame locals released only when chunked).
- [x] Resume re-downloads only `pending` (missing-file) images, never re-ML's `processed`; `recoverStuckJobs` nulls dangling cache paths (C3 — existence-based null in `db/index.ts`).
- [x] Finalize emits ONE terminal event with accumulated totals; status = `failed` if any chunk failed, `cancelled` if loop broke on cancel (early return, no event), else `completed` (M4); deployment → `processed`/`scanned`.
- [x] statfs unmeasurable → never an unbounded bulk download (M1 — `getFreeDiskBytes` returns `null`, decision treats `null` as "doesn't fit").

---

## Pitfalls / edge cases (re-verified)

1. **`schema.*` ↔ `biochoco_*`** — all refs hit `biochoco_*` (`gotcha_camera_trap_tables_empty_biochoco_active`).
2. **`better-sqlite3` sync transactions** — `releaseChunkFiles`/`recoverStuckJobs` use sequential `await`/sync `.run()`, never `db.transaction(async …)`.
3. **`supportsAllDrives:true`** — `downloadFile` (`drive-client.ts:593`) sets it; chunked reuses `downloadDeploymentImages`.
4. **Cancellation mid-chunk** — `checkCancelled()` at loop top + `isCancelled` inside `downloadDeploymentImages` (`:622-625`); returns `{ cancelled: true }`, finalize leaves status `cancelled`, no terminal event (M4).
5. **Resume / dangling cache paths** — fixed in §B9 (existence-based null in `recoverStuckJobs`). Resume invariant stated there.
6. **Frame re-download cost** — release frame locals only on chunked path.
7. **`compressFirst` + chunked** — per-chunk before ML+release (§B8); never silently skip; fail-fast fallback available.
8. **Thumbnails before delete** — `downloadImageSet` thumbnails before the loop releases.
9. **`evictIfOverLimit`** — now in `computePendingDownload` so it runs for both paths (M3); already skips current deployment (`:508`).
10. **statfs scope** — measures root fs (where `data/` bind-mounts). Revisit (statfs the cache path) if `data/` moves to a separate volume.
11. **Co-tenant disk** — 20 GB margin protects ~20 containers + ODK Central Postgres (no restart policy). Don't shrink casually.
12. **`runMLPredictions` map keyed on `path`** (`ml-runner.ts:776-786`) — released chunks (path null) drop out correctly; §B9's dangling-path fix prevents a stale path mis-attributing. Note in code.
13. **Progress UX contract** — preserve `downloadedImages`/`downloadTotal`/`statusMessage`; C1 keeps `processedImages` cumulative so `floating-job-progress.tsx` stays correct.

## Dependencies & Risks

- **Node 22** has `fs/promises.statfs`. No new deps.
- **Warm model server** stays loaded across per-chunk `runMLPredictions` calls (`ensureModelServer`, 10-min idle) — no per-chunk model reload.
- **Risk: frame re-download** wastes Drive bandwidth on chunked video deployments (mitigated: chunked-only release; gaxios v7 retry handled — `gotcha_gaxios_v7_retry_reason`).
- **Risk: C1/M4 regressions** — covered by the new progress-monotonicity and finalize-status tests.

## Rollout

1. **Part A** → deploy → verify a deliberately-too-big job (high `CT_PROCESS_DISK_MARGIN_GB`) fails cleanly + a statfs-failure path doesn't permit bulk.
2. **Part B** (default `CHUNKING_ENABLED=true`) → scratch deployment (`watch du -sh`) → then a fresh job for deployment 131 (old job 341 is `cancelled`) end-to-end; confirm monotonic progress.
3. **Docs:** update `CLAUDE.md` (camera-trap/ML: chunking knobs + emergency lever); mark `incident_disk_full_biochoco_download` fixed.

## Out of Scope

- Resizing the droplet / block-storage volume for `data/` (complementary infra; 193 GB is tight) — independent.
- ODK Central Postgres restart policy (separate incident/compose).
- Legacy unused `processing_jobs`/`images`/`deployments` SQL tables.

## References (verified 2026-05-26)

- Spec: `docs/plans/ml-chunked-download-spec.md`
- Runner: `src/app/camera-trap/actions.ts:314-954` · Compression: `drive-actions.ts:423-520`
- Downloader: `src/lib/drive-downloader.ts:73-262` (eviction `:467-543`, existence split `:142-154`)
- Batch download: `src/lib/drive-client.ts:606-658` (single `:586-600`)
- ML runner: `src/lib/ml-runner.ts:771-852` (per-image persist `:451-494`, progress write `:486-494`, `processedCount` reset `:828-838`)
- Recovery: `src/db/index.ts:173-267` (camera-trap branch `:219-231`)
- Progress UI: `src/components/floating-job-progress.tsx:188-217`
- Proxy fallback: `src/app/api/ct-images/[id]/route.ts:136-173`
- Schema: `src/db/schema.ts` (jobs `212-252`, images `258-307`, deployments `128-206`)
- Tests: `tests/helpers/test-db.ts`; `tests/integration/{job-queue,camera-trap-jobs}.test.ts`
- Memory: `incident_disk_full_biochoco_download`, `incident_odk_central_postgres_down_after_disk_full`, `gotcha_camera_trap_tables_empty_biochoco_active`, `gotcha_gaxios_v7_retry_reason`
