---
title: "feat: BirdNET Audio Analysis Integration"
type: feat
date: 2026-04-13
---

# BirdNET Audio Analysis Integration

## Overview

Add automated bird sound identification using [BirdNET-Analyzer](https://github.com/birdnet-team/BirdNET-Analyzer) to the existing audio recordings module. Mirrors the camera trap ML pipeline architecture for consistency, but scoped to the minimum needed to get BirdNET running and results reviewable.

## Problem Statement

FCAT deploys passive acoustic recorders across the Chocó reserve. Each deployment produces dozens to hundreds of audio files. Manually annotating spectrograms is prohibitively slow. BirdNET identifies 6,000+ bird species from audio with location/season filtering — perfect for FCAT's context.

## Proposed Solution

### Architecture

```
User clicks "Analizar con BirdNET" → inline confirm
    ↓
createBirdNETJob(deploymentId)          → processingJobs row (jobType="birdnet")
    ↓ fire-and-forget
processBirdNETJob(jobId)
    ├─ Phase 1: Download audio from Drive → cache (determinate progress)
    ├─ Phase 2: Spawn birdnet-runner.py → NDJSON progress (determinate)
    └─ Phase 3: Insert results + finalize
    ↓
FloatingJobProgress shows "Análisis BirdNET: X de Y archivos"
    ↓
Completion links to deployment page → user reviews in annotation UI
```

### Key Decisions

1. **Single-shot CLI, not persistent server.** BirdNET TFLite loads in ~2s. No singleton management needed.
2. **Reuse `processingJobs` table** with `jobType: "birdnet"`. Progress APIs work unchanged.
3. **Add `jobId` FK to `audioDetections`.** Enables clean re-run: delete ML detections (`jobId IS NOT NULL`), preserve manual (`jobId IS NULL`).
4. **No results pages in v1.** The annotation UI at `/audio/[id]/annotate/[fileId]/` already handles detection review, species assignment, and verification. Show BirdNET status on the deployment page instead. Add a dedicated results dashboard later if users ask for it.
5. **No confirmation dialog file.** BirdNET has zero configurable options (all hardcoded). Use inline button confirm state. Show re-run warning via `window.confirm()` when prior detections exist.
6. **Hardcoded parameters.** `min_conf=0.1`, `sensitivity=1.0`, `overlap=1.0`, `locale=es`. Defer configurable UI.
7. **Independent from camera trap queue.** Different resources. One BirdNET job per deployment, doesn't block camera trap jobs.

## Technical Approach

### Phase 1: Infrastructure

#### 1.1 Add `birdnet-analyzer` to ML venv

**File:** `scripts/ensure-ml-venv.sh`

After librosa install (line 148):
```bash
echo "[ml-setup] Installing birdnet-analyzer..."
uv pip install --python "$ML_PYTHON" birdnet-analyzer
```

Update import check (line 120):
```bash
if "$ML_PYTHON" -c "import PytorchWildlife; import librosa; import timm; import birdnet_analyzer" 2>/dev/null; then
```

**Risk:** TFLite (BirdNET) + PyTorch (PytorchWildlife) in same venv. If conflicts, fall back to separate `data/birdnet-venv/` with its own `BIRDNET_PYTHON_PATH` env var.

#### 1.2 Add `jobId` to `audioDetections` schema

**File:** `src/db/schema.ts` (~line 788)

```typescript
jobId: integer("job_id").references(() => processingJobs.id, { onDelete: "set null" }),
```

Add index:
```typescript
index("idx_audio_detections_job").on(table.jobId),
```

**File:** `scripts/push-schema.mjs` — migration array:
```javascript
// BirdNET integration — add job_id to audio_detections (2026-04-13)
`ALTER TABLE audio_detections ADD COLUMN job_id INTEGER REFERENCES biochoco_processing_jobs(id) ON DELETE SET NULL`,
```

#### 1.3 Create `scripts/birdnet-runner.py`

Minimal single-shot Python wrapper (**under 100 lines**). Reads config JSON from stdin, runs BirdNET CLI, parses CSV output, streams NDJSON.

**stdin** (single JSON line):
```json
{"audio_dir": "/app/data/cache/audio/42/", "output_dir": "/tmp/birdnet-XXXX",
 "lat": -0.3, "lon": -79.2, "week": 12, "min_conf": 0.1, "threads": 3,
 "total_files": 50}
```

**stdout** (NDJSON):
```
{"type": "info", "message": "Iniciando análisis BirdNET..."}
{"type": "progress", "index": 5, "total": 50}
{"type": "result", "file": "2MM21799_20260119_193500.wav", "detections": [
  {"start": 12.0, "end": 15.0, "scientific_name": "Ramphastos ambiguus",
   "common_name": "Tucán Mandíbula Negra", "confidence": 0.85}
]}
{"type": "complete", "total_processed": 50, "total_detections": 312}
```

Implementation:
- Run `python -m birdnet_analyzer.analyze <audio_dir> -o <output_dir> --rtype csv` with all params
- Don't pre-filter file formats — let BirdNET skip what it can't read (verify it fails gracefully on `.wac`/`.w4v` during testing; add pre-filtering only if needed)
- Parse stderr for progress (BirdNET `--show_progress`)
- Parse per-file CSV results: columns `Start (s)`, `End (s)`, `Scientific name`, `Common name`, `Confidence`
- `flush=True` on all stdout writes
- Clean up temp output dir on completion

#### 1.4 Create `src/lib/birdnet-runner.ts`

Node.js bridge. Spawns Python, parses NDJSON, inserts results into DB.

Pattern from `src/lib/ml-runner.ts:388-530` but simpler — no singleton, no idle timer.

```typescript
export type BirdNETRunResult =
  | { success: true; totalProcessed: number; totalDetections: number }
  | { success: false; totalProcessed: number; totalDetections: number; error: string };

export async function runBirdNETAnalysis(
  jobId: number,
  config: { audioDir: string; lat: number; lon: number; week: number;
            minConf: number; threads: number; totalFiles: number },
  filenameToFileId: Map<string, number>,
): Promise<BirdNETRunResult>
```

Key behavior:
- Spawn `scripts/birdnet-runner.py` via `child_process.spawn`
- Send config JSON + newline to stdin, close stdin
- Parse stdout line-by-line via `readline`
- On `progress`: `db.update(processingJobs).set({ processedImages, statusMessage })`
- On `result`: for each detection, insert `audioDetections` (with `jobId`, `modelVersion: "birdnet-analyzer"`, `minFreq: 0`, `maxFreq: 15000`) + `audioIdentifications` (`species`, `confidence`, `verificationStatus: "unverified"`)
- On `complete`: resolve promise
- Store PID on `processingJobs` for cancellation
- Thread cap: `Math.max(1, os.availableParallelism() - 1)`

**Gotcha:** Do NOT use `db.transaction(async ...)`. better-sqlite3 requires synchronous callbacks. Use sequential `await db.insert().returning()`.

### Phase 2: Job Management

#### 2.1 Server actions

**File:** `src/app/audio/actions.ts` — add at bottom:

**`createBirdNETJob(deploymentId: number): ActionResult<{ jobId: number }>`**

1. `requirePermission("grabaciones", "editor")` + `requireDeploymentAccess`
2. Query `audioFiles` count; error if 0
3. Concurrency guard: check for active **BirdNET** job on deployment. **Must filter by `jobType: "birdnet"`** to avoid blocking camera trap jobs:
   ```typescript
   const [activeJob] = await db.select({ id: processingJobs.id })
     .from(processingJobs)
     .where(and(
       eq(processingJobs.deploymentId, deploymentId),
       eq(processingJobs.jobType, "birdnet"),
       inArray(processingJobs.status, ["pending", "processing"])
     ))
     .limit(1);
   ```
4. Clean up prior BirdNET detections — mirror camera trap pattern (`actions.ts:168`):
   ```sql
   DELETE FROM audio_detections
   WHERE audio_file_id IN (SELECT id FROM audio_files WHERE deployment_id = ?)
   AND job_id IS NOT NULL
   ```
   Preserves manual annotations (`job_id IS NULL`). Cascade-deletes `audioIdentifications` via FK.
5. Insert `processingJobs`: `jobType: "birdnet"`, `totalImages: fileCount`, `status: "pending"`
6. Fire-and-forget: `processBirdNETJob(jobId)` (no await)
7. Return `{ jobId }`

**`processBirdNETJob(jobId: number): Promise<void>`**

**Entire function body wrapped in try/catch** (not just the inner phases — prevents unhandled rejection from setup queries):
1. Set status `"processing"`, `startedAt`
2. Look up deployment lat/lon (fallback: `-0.3`, `-79.2`). **Log warning if using fallback.**
3. Compute `week` from **deployment `dateStart`** (not filename parsing — simpler, more reliable):
   ```typescript
   const week = deployment.dateStart
     ? Math.ceil(dayOfYear(new Date(deployment.dateStart)) / 7)
     : -1; // -1 = year-round species list
   ```
4. **Download phase:** for each audio file, `await ensureAudioCached(file.id)`, update `downloadedImages`/`downloadTotal`. Status: `"Descargando audio... (X de Y)"`. Skip files without `driveFileId`.
5. **Analysis phase:** `await runBirdNETAnalysis(jobId, config, filenameToFileId)`
6. **Finalize:** `status: "completed"`, `completedAt`, detection count in statusMessage
7. Catch: `status: "failed"`, `errorMessage`

**`cancelBirdNETJob(jobId: number): ActionResult`**

1. Auth check, verify job is active
2. `process.kill(job.pid, "SIGTERM")`
3. Delete partial detections: `DELETE FROM audio_detections WHERE job_id = ?`
4. Set `status: "cancelled"`, `completedAt`

#### 2.2 Fix camera trap concurrency guard

**File:** `src/app/camera-trap/actions.ts` (~line 88-97)

The existing guard queries for ANY active job on a deployment without filtering by `jobType`. Add a filter so camera trap jobs only block other camera trap jobs:

```typescript
const [activeJob] = await db
  .select({ id: processingJobs.id })
  .from(processingJobs)
  .where(
    and(
      eq(processingJobs.deploymentId, deploymentId),
      inArray(processingJobs.status, ["pending", "processing"]),
      // Don't block on BirdNET or other job types
      inArray(processingJobs.jobType, ["ml", "ml_incremental", "compression", "revert_compression"])
    )
  )
  .limit(1);
```

Without this fix, running a camera trap job would block BirdNET jobs on the same deployment and vice versa.

#### 2.3 Unify cancel in floating job progress

**File:** `src/components/floating-job-progress.tsx`

Currently imports `cancelJob` from camera-trap actions (line 8). This won't work for BirdNET jobs. Two changes:

**Option chosen: Unified cancel action.**

Create a generic cancel action (in a shared location, e.g. `src/app/audio/actions.ts` or a new `src/lib/job-actions.ts`):

```typescript
export async function cancelProcessingJob(jobId: number): ActionResult {
  const [job] = await db.select().from(processingJobs).where(eq(processingJobs.id, jobId));
  if (!job) return { success: false, error: "Trabajo no encontrado" };

  if (job.jobType === "birdnet") {
    return cancelBirdNETJob(jobId);
  }
  return cancelCameraTrapJob(jobId); // renamed from cancelJob
}
```

Update `floating-job-progress.tsx` to import `cancelProcessingJob` instead of `cancelJob`. This keeps the component job-type-agnostic.

#### 2.4 Extend floating job progress

**File:** `src/components/floating-job-progress.tsx`

Add `birdnet` to job type handling. Instead of growing the conditional chain, extract a config map:

```typescript
const JOB_TYPE_CONFIG: Record<string, { unit: string; header: string; pill: string; resultPath: (id: number, depId: number) => string }> = {
  ml: { unit: "imágenes", header: "Trabajo de ML", pill: "Procesando...", resultPath: (id) => `/camera-trap/results/${id}` },
  ml_incremental: { unit: "imágenes", header: "Trabajo de ML", pill: "Procesando...", resultPath: (id) => `/camera-trap/results/${id}` },
  compression: { unit: "imágenes", header: "Compresión de imágenes", pill: "Comprimiendo...", resultPath: (_, depId) => `/camera-trap/${depId}` },
  revert_compression: { unit: "imágenes", header: "Revirtiendo compresión", pill: "Revirtiendo...", resultPath: (_, depId) => `/camera-trap/${depId}` },
  birdnet: { unit: "archivos", header: "Análisis BirdNET", pill: "Analizando audio...", resultPath: (_, depId) => `/audio/${depId}` },
};
```

This replaces the `isCompression`/`isRevert`/`isBirdnet` boolean chain with data-driven lookups.

#### 2.5 Progress/active-jobs APIs

**No changes needed.** Both query `processingJobs` generically. SSE streams `processedImages`/`totalImages`. Stuck-job recovery in `src/db/index.ts:157` queries all processing jobs regardless of `jobType` — BirdNET jobs are recovered automatically on restart.

### Phase 3: UI

#### 3.1 "Analizar con BirdNET" button

**File:** `src/app/audio/[id]/audio-files-shell.tsx`

Add button in header area alongside existing "Escanear" button:
- Visible when `isEditor && files.length > 0`
- Icon: `Bird` from lucide-react
- **Inline confirm state** (no dialog file): button text changes to "¿Confirmar?" for 3 seconds, then reverts. On second click within that window, starts the job.
- When prior BirdNET detections exist: `window.confirm("Se eliminarán las detecciones BirdNET previas. Las anotaciones manuales se conservarán. ¿Continuar?")` before proceeding
- After start: button disabled, text "Procesando...", helper text "Progreso visible en el widget flotante"
- `window.dispatchEvent(new Event("job-started"))` to trigger floating progress refresh

**File:** `src/app/audio/[id]/page.tsx`

Query active BirdNET job for this deployment to pass down `isProcessing` prop:
```typescript
const [activeJob] = await db.select({ id: processingJobs.id })
  .from(processingJobs)
  .where(and(
    eq(processingJobs.deploymentId, deploymentId),
    eq(processingJobs.jobType, "birdnet"),
    inArray(processingJobs.status, ["pending", "processing"])
  )).limit(1);
```

Also query last completed BirdNET job stats to show on the deployment page:
```typescript
// Show: "BirdNET: 312 detecciones, 23 especies (hace 2 horas)"
```

#### 3.2 BirdNET status on deployment page

**File:** `src/app/audio/[id]/audio-files-shell.tsx` (or a small child component)

After the header, show a status line if BirdNET has been run:
- "BirdNET: 312 detecciones, 23 especies · 180 verificadas, 132 pendientes · hace 2 horas"
- Or: "BirdNET: procesando... (12 de 42 archivos)"
- Or: nothing if never analyzed

This replaces the full results page for v1. Users click individual files to review in the annotation UI.

#### 3.3 Sidebar nav

**File:** `src/components/sidebar-nav.tsx` (line 174)

**No changes for v1.** No results page = no nav item to add. The existing "Instalaciones" link at `/audio` is sufficient.

#### 3.4 Verification

**No changes needed.** BirdNET detections land in `audioDetections`/`audioIdentifications`. The annotation UI at `/audio/[id]/annotate/[fileId]/` handles everything:
- Detection boxes on spectrogram (BirdNET = full-height time bands)
- Species sidebar with confidence
- Verify/reject/correct workflows
- `verifyAllAudioAndAdvance` for bulk review
- Detections distinguished by `modelVersion: "birdnet-analyzer"` vs `"manual"`

**UX note:** Full-height detection boxes may look noisy with many overlapping detections. Consider rendering BirdNET detections with lower opacity or dashed borders to visually distinguish from manual annotations. Test with real data and adjust.

## BirdNET Parameters (Hardcoded)

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `--lat` | Deployment lat or `-0.3` | FCAT Chocó default |
| `--lon` | Deployment lon or `-79.2` | FCAT Chocó default |
| `--week` | From `deployment.dateStart` | Seasonal species filtering |
| `--min_conf` | `0.1` | Store all, filter in UI |
| `--sensitivity` | `1.0` | Default |
| `--threads` | `cpus - 1` | Leave headroom |
| `--rtype` | `csv` | Easiest to parse |
| `--locale` | `es` | Spanish common names |
| `--overlap` | `1.0` | Better segment boundary detection |

## Acceptance Criteria

- [x] BirdNET installable in ML venv without breaking PytorchWildlife
- [x] "Analizar con BirdNET" button on deployment pages (editors, files > 0)
- [x] Inline confirm + `window.confirm` re-run warning
- [x] Progress bar: download phase then analysis phase with "X de Y archivos"
- [x] BirdNET detections appear in existing annotation UI
- [x] Verification workflow works for BirdNET detections
- [x] Re-run deletes ML detections (`job_id IS NOT NULL`), preserves manual (`job_id IS NULL`)
- [x] Cancel kills process + deletes partial detections
- [x] BirdNET status line on deployment page (detection count, species count, verification progress)
- [x] Camera trap concurrency guard updated to filter by `jobType`
- [x] Unified cancel action works for both job types
- [x] Files without `driveFileId` skipped
- [x] Concurrent job guard per deployment (BirdNET-only, doesn't block camera trap)
- [x] `npm run build` passes

## Dependencies & Risks

- **Venv conflict:** BirdNET (TFLite) + PytorchWildlife (PyTorch). Mitigation: test in shared venv first, fall back to separate venv.
- **Proprietary formats:** `.wac`/`.w4v` may not be readable by BirdNET. Mitigation: test during implementation; add pre-filtering only if BirdNET crashes (rather than skips) on these formats.
- **Species taxonomy:** BirdNET uses eBird taxonomy; portal has its own `species` table. Detections store raw `scientific_name`. Species sidebar autocomplete works for correction.
- **Week approximation:** `--week` is computed from `deployment.dateStart` and applies to the entire run. For multi-week deployments, seasonal filtering may be slightly off for later files. Acceptable for v1.

## Files to Modify

| File | Change |
|------|--------|
| `scripts/ensure-ml-venv.sh` | Add `birdnet-analyzer` pip install + import check |
| `scripts/push-schema.mjs` | Add `ALTER TABLE audio_detections ADD COLUMN job_id` migration |
| `src/db/schema.ts` | Add `jobId` FK + index on `audioDetections` |
| `src/app/audio/actions.ts` | Add `createBirdNETJob`, `processBirdNETJob`, `cancelBirdNETJob` |
| `src/app/audio/[id]/audio-files-shell.tsx` | Add "Analizar con BirdNET" button + BirdNET status line |
| `src/app/audio/[id]/page.tsx` | Query active BirdNET job + last completed job stats |
| `src/app/camera-trap/actions.ts` | Add `jobType` filter to concurrency guard (~line 88-97) |
| `src/components/floating-job-progress.tsx` | Add `jobTypeConfig` map, unified cancel import |

## Files to Create

| File | Purpose | Mirrors |
|------|---------|---------|
| `scripts/birdnet-runner.py` | Python wrapper: BirdNET CLI → NDJSON (<100 lines) | `scripts/model-server.py` (much simpler) |
| `src/lib/birdnet-runner.ts` | Node.js bridge: spawn Python, parse NDJSON, insert results | `src/lib/ml-runner.ts` (much simpler) |

## Deferred to v2 (if users request)

- Results list page (`/audio/results`) with stats cards + sortable job table
- Results detail page (`/audio/results/[id]`) with species summary + confidence slider
- Configurable BirdNET parameters (confidence threshold, sensitivity) in a settings dialog
- Sidebar nav item for BirdNET results
- `.wac`/`.w4v` format conversion (requires Wildlife Acoustics SDK or sox)
- Custom BirdNET classifier training from verified detections

## Learnings Applied

- **Async transaction trap** (`docs/solutions/runtime-errors/async-transaction-better-sqlite3`): never use `async` in `db.transaction()`
- **Process explosion** (`docs/solutions/runtime-errors/spectrogram-process-explosion-AudioCache`): use inflight dedup for subprocess spawning
- **Docker ML install** (`docs/solutions/build-errors/pytorchwildlife-docker-install-failures`): verify imports after pip install
- **ALTER TABLE migrations** (`docs/solutions/database-issues/missing-alter-table-migrations-push-schema`): must use ALTER TABLE for existing tables

## Verification Plan

1. **Venv:** `docker compose exec portal data/ml-venv/bin/python3 -c "import birdnet_analyzer; print('ok')"`
2. **Schema:** `docker compose exec portal node scripts/push-schema.mjs`
3. **Python runner standalone:** `echo '{"audio_dir":"test/","lat":-0.3,...}' | data/ml-venv/bin/python3 scripts/birdnet-runner.py`
4. **Full flow:** deployment page → "Analizar con BirdNET" → confirm → floating progress → deployment page shows status → annotation page → verify detections
5. **Re-run:** analyze same deployment again → prior BirdNET detections deleted, manual preserved
6. **Cancel:** start job → cancel → partial detections cleaned up
7. **Concurrency:** start camera trap job → verify BirdNET button still works on same deployment
8. **Build:** `npm run build` passes
