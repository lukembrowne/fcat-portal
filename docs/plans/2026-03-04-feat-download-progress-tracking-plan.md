---
title: "feat: Rich download progress tracking for camera trap processing"
type: feat
date: 2026-03-04
---

# Rich Download Progress Tracking for Camera Trap Processing

## Overview

When processing camera trap deployments, the image download phase shows an indeterminate progress bar with a vague "Descargando imagenes de Drive..." message. The actual download happens in batches of 50 inside `downloadDeploymentImages()` which has no progress callback — useful per-batch data is logged to Docker but never surfaced to the UI.

This plan adds real download progress: a determinate progress bar, file counts, cache hit info, ETA, and improved Docker logging.

## Problem Statement

**Current behavior during download phase:**
- Progress bar: indeterminate (pulsing animation)
- `processedImages` stays at 0 the entire time
- `statusMessage` says "Descargando imagenes de Drive..." then "Descargando imagenes... (X de Y)" — but X/Y actually tracks *thumbnail generation*, not downloads
- Docker logs show batch progress (`Download batch 1/4: 50 ok, 0 failed`) but this isn't surfaced
- Available but hidden: cached vs. to-download count, per-batch progress, failure count, estimated size

**What the user sees (from screenshot):**
- "Descargando imagenes de Drive..." with pulsing green bar
- "Preparando... · 8m 42s" — no counts, no ETA, no percentage

## Proposed Solution

### Schema: Add download tracking columns to `processingJobs`

Add three columns to `processingJobs`:

```
downloadedImages  INTEGER DEFAULT 0   -- files successfully downloaded so far
downloadTotal     INTEGER DEFAULT 0   -- files that need downloading (excludes cached)
cachedImages      INTEGER DEFAULT 0   -- files found in cache (set once at start)
```

These are separate from `processedImages`/`totalImages` (which track ML analysis) so there's no conflict or progress bar regression between phases.

**Phase detection in UI:** `downloadTotal > 0 && downloadedImages < downloadTotal` means download in progress. Once `downloadedImages >= downloadTotal`, download is done. The progress bar transitions cleanly to the ML phase using `processedImages/totalImages`.

### Changes by file

#### 1. `src/db/schema.ts` — Add columns

Add `downloadedImages`, `downloadTotal`, `cachedImages` to `processingJobs` table.

#### 2. `src/lib/drive-client.ts` — Add `onProgress` to `downloadDeploymentImages()`

Add an optional callback parameter:

```typescript
export async function downloadDeploymentImages(
  imageFiles: { id: string; name: string; relativePath: string }[],
  destDir: string,
  onProgress?: (downloaded: number, failed: number, total: number) => void,
): Promise<{ pathMap: Map<string, string>; downloaded: number; failed: number }> {
```

Call `onProgress` after each batch of 50 completes. This is the right granularity — matches existing batch structure, keeps DB writes to ~10 for a 500-image deployment.

**Improve Docker logging** in the same batch loop:

```
[Drive] Deployment 141: batch 3/10 — 150 ok, 0 failed (12.4s, 45.2 MB/s, RSS: 380MB)
```

Add batch timing (`Date.now()` delta), throughput (bytes downloaded / elapsed), and total elapsed.

#### 3. `src/lib/drive-downloader.ts` — Thread progress through `downloadDeploymentForProcessing()`

Update the function to accept a richer `onProgress` callback and call it at each sub-phase:

**Sub-phase A — Pre-flight (before download starts):**
```typescript
onProgress?.({ phase: "preflight", cached: alreadyCached.size, toDownload: toDownload.length });
```

**Sub-phase B — Download (per batch):**
```typescript
// Inside downloadDeploymentImages callback:
onProgress?.({ phase: "downloading", downloaded, failed, total: toDownload.length });
```

**Sub-phase C — Thumbnails (per batch of 20):**
```typescript
onProgress?.({ phase: "thumbnails", generated: thumbsDone, total: allImages.length });
```

#### 4. `src/app/camera-trap/actions.ts` — Write progress to DB

In `processJobInternal()`, use the `onProgress` callback to update `processingJobs`:

```typescript
const result = await downloadDeploymentForProcessing(imageFiles, deploymentId, {
  onProgress: ({ phase, cached, toDownload, downloaded, failed, total, generated }) => {
    if (phase === "preflight") {
      await db.update(processingJobs).set({
        cachedImages: cached,
        downloadTotal: toDownload,
        statusMessage: cached > 0
          ? `${cached} en cache, descargando ${toDownload}...`
          : `Descargando ${toDownload} imagenes de Drive...`,
      }).where(eq(processingJobs.id, jobId));
    } else if (phase === "downloading") {
      await db.update(processingJobs).set({
        downloadedImages: downloaded,
        failedImages: failed,
        statusMessage: failed > 0
          ? `Descargando... ${downloaded} de ${total} (${failed} fallidos)`
          : `Descargando... ${downloaded} de ${total}`,
      }).where(eq(processingJobs.id, jobId));
    } else if (phase === "thumbnails") {
      await db.update(processingJobs).set({
        statusMessage: `Generando miniaturas... ${generated} de ${total}`,
      }).where(eq(processingJobs.id, jobId));
    }
  },
});
```

Also add **cancellation check between download batches**: pass `jobId` through so the download loop can check if the job was cancelled between batches. This is a cheap DB read (~1ms) and provides cancellation within ~30 seconds.

#### 5. `src/app/api/progress/route.ts` — Include new fields in SSE

Add the three new columns to the SSE payload:

```typescript
{
  // ...existing fields...
  downloadedImages: job.downloadedImages,
  downloadTotal: job.downloadTotal,
  cachedImages: job.cachedImages,
}
```

#### 6. `src/app/api/active-jobs/route.ts` — Include new fields

Same three fields added to the active-jobs response.

#### 7. `src/components/floating-job-progress.tsx` — Determinate download progress

Update the progress bar logic:

```typescript
const isDownloading = sseData?.downloadTotal > 0 && sseData?.downloadedImages < sseData?.downloadTotal;
const isAnalyzing = status === "processing" && (sseData?.processed ?? 0) > 0;

// Progress bar percentage
const percentage = isDownloading
  ? Math.round((sseData.downloadedImages / sseData.downloadTotal) * 100)
  : isAnalyzing
    ? Math.round((sseData.processed / sseData.total) * 100)
    : 0;
```

Show determinate bar during download phase (not just ML). The `statusMessage` already contains the human-readable text.

**ETA calculation (client-side):**

```typescript
// Compute from download rate: files downloaded / seconds elapsed
const elapsed = (Date.now() - startedAt) / 1000;
const rate = sseData.downloadedImages / elapsed; // files per second
const remaining = sseData.downloadTotal - sseData.downloadedImages;
const etaSeconds = rate > 0 ? remaining / rate : 0;
// Display: "~2 min restante" or "~30 seg restante"
```

ETA is computed client-side since the client already tracks elapsed time. This avoids polluting `statusMessage` and updates smoothly between SSE events.

#### 8. Docker logging improvements

Enhance logging throughout the pipeline:

**drive-client.ts** — per-batch download logging:
```
[Drive] Deployment 141: batch 3/10 — 150 ok, 0 failed (12.4s, 45.2 MB/s, RSS: 380MB)
```

**drive-downloader.ts** — pre-flight summary:
```
[drive-downloader] Job 91, deployment 141: 150 cached, 200 to download (~450.3 MB est.)
```

**drive-downloader.ts** — completion summary:
```
[drive-downloader] Job 91: download complete — 200 ok, 0 failed (45.2s, 10.0 MB/s avg)
[drive-downloader] Job 91: thumbnails complete — 350 generated (22.1s)
```

**actions.ts** — phase transitions:
```
[process] Job 91: starting download phase (350 images, 150 cached)
[process] Job 91: download complete, starting ML analysis
[process] Job 91: ML complete — 350 analyzed (245 animal, 85 blank, 20 human)
```

### UI result

**Floating widget during download:**
```
GIZ-014_V1
Trabajo #91

Descargando... 120 de 200
████████████░░░░░░░░░  60%

~2 min restante · 3m 12s

Ver detalles · Cancelar
```

**Full progress page during download:**
```
Descargando imagenes de Drive...      ● En vivo

████████████░░░░░░░░░░░░░░░░░░░

150 en cache · Descargando... 120 de 200 (60%) · ~2 min restante · 3m 12s

[Cancelar procesamiento]
```

## Testing

### Existing tests to update

**`tests/integration/camera-trap-jobs.test.ts`**
- The mock for `downloadDeploymentForProcessing` (line 35) needs to invoke the `onProgress` callback since the function signature now accepts it
- Add assertions that after `downloadDeploymentForProcessing` is called, the job row has `downloadedImages`, `downloadTotal`, and `cachedImages` populated
- Verify `statusMessage` contains download counts during the download phase

### New tests to add

**`tests/unit/drive-downloader-progress.test.ts`** — Unit tests for the progress callback contract:
- `onProgress` is called with `phase: "preflight"` before downloads begin, reporting cache/download split
- `onProgress` is called with `phase: "downloading"` after each batch, with correct running totals
- `onProgress` is called with `phase: "thumbnails"` after each thumbnail batch
- When all images are cached (`toDownload.length === 0`), download phase is skipped — only preflight and thumbnails fire
- When `onProgress` is not provided, function works identically to before (backward compat)

**`tests/integration/camera-trap-jobs.test.ts`** — New integration test cases:
- "download progress is written to DB during processing" — mock `downloadDeploymentForProcessing` to call `onProgress` with preflight + downloading phases, then assert the job row has correct `downloadedImages`/`downloadTotal`/`cachedImages`
- "cancellation during download aborts between batches" — set job status to `cancelled` in DB, verify the download loop exits early on next batch boundary

**`tests/unit/api-routes.test.ts`** — Verify the SSE and active-jobs endpoints include the new fields:
- `/api/progress` SSE payload includes `downloadedImages`, `downloadTotal`, `cachedImages`
- `/api/active-jobs` response includes the same fields

## Acceptance Criteria

- [x] Download phase shows determinate progress bar (not indeterminate pulsing)
- [x] User sees "X de Y" file count during downloads, updated per batch of 50
- [x] Cache hit count displayed when images are already cached ("150 en cache")
- [x] ETA shown during download phase ("~2 min restante")
- [x] Download failures shown inline ("3 fallidos")
- [x] Thumbnail generation shows as separate sub-phase ("Generando miniaturas... X de Y")
- [x] Docker logs show per-batch timing, throughput, and memory
- [x] Cancel during download takes effect within ~30 seconds (between batches)
- [x] Progress transitions cleanly from download phase to ML phase without bar regression
- [x] Video downloads also show progress (same pattern)
- [x] Fully-cached deployments show "350 en cache" briefly then move to thumbnails/ML
- [x] Existing integration tests updated for new `onProgress` callback
- [ ] New unit tests for progress callback contract
- [ ] New integration tests for download-to-DB progress flow

## Files to modify

| File | Change |
|---|---|
| `src/db/schema.ts` | Add 3 columns to `processingJobs` |
| `scripts/push-schema.mjs` | Schema push will add columns |
| `src/lib/drive-client.ts` | Add `onProgress` callback to `downloadDeploymentImages()` |
| `src/lib/drive-downloader.ts` | Thread progress through, split into download/thumbnail sub-phases |
| `src/app/camera-trap/actions.ts` | Write download progress to DB, add cancellation check |
| `src/app/api/progress/route.ts` | Include new columns in SSE payload |
| `src/app/api/active-jobs/route.ts` | Include new columns in response |
| `src/components/floating-job-progress.tsx` | Determinate bar during download, ETA, phase-aware labels |
| `tests/integration/camera-trap-jobs.test.ts` | Update mocks, add progress integration tests |
| `tests/unit/drive-downloader-progress.test.ts` | New: progress callback unit tests |
| `tests/unit/api-routes.test.ts` | Add assertions for new SSE/active-jobs fields |

## Out of scope

- Batch-level backoff coordination for Drive rate limits (existing per-file `withRetry` is sufficient)
- Download failure threshold / automatic abort (proceed with whatever succeeded, as today)
- Byte-level throughput in UI (files/second is simpler, throughput stays in Docker logs)
- Resume interrupted downloads (cache already handles this on re-run)
