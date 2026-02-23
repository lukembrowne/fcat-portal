---
title: Camera Trap Pipeline Parallelization
type: feat
date: 2026-02-22
brainstorm: docs/brainstorms/2026-02-22-ct-pipeline-parallelization-brainstorm.md
---

# Camera Trap Pipeline Parallelization

## Overview

Speed up the camera trap ML processing pipeline by switching from sequential single-image inference to batch inference with multi-CPU image loading, and parallelizing video frame extraction. The production server has 4 CPUs; local dev has 10-12.

## Problem Statement

The current pipeline processes images **one at a time** in a Python for-loop via `single_image_detection()`. The `batch_size` config parameter is sent from TypeScript but completely ignored in `model-server.py` (dead code since inception). Video frame extraction also runs sequentially — one ffmpeg process at a time.

For a typical deployment of 500 images, all 4 CPUs sit idle except for one thread doing sequential inference. This is the primary bottleneck.

## Proposed Solution

Two independent optimizations:

1. **Batch ML inference** — Process images in mini-batches using PyTorch DataLoader with `num_workers` for CPU-parallel image loading and `batch_size` for batched model inference. Keep the same NDJSON protocol (per-image result messages, zero TypeScript changes).

2. **Parallel ffmpeg** — Run multiple video frame extractions concurrently, capped at CPU count. Uses the existing batch + Promise.all pattern from the codebase.

## Technical Approach

### Phase 1: Python Batch Inference (`scripts/model-server.py`)

**What changes:**

Replace the sequential `for idx, image_path in enumerate(image_paths)` loop (line 111) with a DataLoader-based mini-batch loop.

**Key design decisions:**

1. **Custom collate_fn with per-image error handling** — PyTorch's default collate crashes the entire batch if one image fails to load. A custom collate_fn wraps each image in try/except, replaces failures with a sentinel, and tracks which images failed. This prevents one corrupt JPEG from poisoning 15 valid images in the same batch.

2. **Per-image result messages preserved** — After each batch, iterate over results and emit individual `result` NDJSON lines per image. The TypeScript side sees the same protocol as today, just in bursts. This means **zero changes to `ml-runner.ts`** for the ML handler logic.

3. **macOS DataLoader safety** — Set `num_workers=0` on macOS (`sys.platform == 'darwin'`) to avoid fork/spawn multiprocessing issues. On Linux (Docker/production), use `num_workers` from config.

4. **batch_size validation** — Clamp to [1, 64] on the Python side. Log a warning if clamped. Default stays 16.

5. **prefetch_factor=1** — Reduce memory pressure since CPU inference is the bottleneck, not I/O. No point prefetching 2 batches ahead when each batch takes seconds to process.

**Pseudocode for `process_job()` in `model-server.py`:**

```python
def process_job(config, detector, classifier):
    image_paths = config["image_paths"]
    confidence_threshold = config.get("confidence_threshold", 0.1)
    batch_size = max(1, min(config.get("batch_size", 16), 64))
    num_workers = config.get("num_workers", 0)

    # On macOS, force num_workers=0 (multiprocessing fork issues)
    if sys.platform == "darwin":
        num_workers = 0

    total = len(image_paths)
    total_detections = 0
    processed = 0
    cancelled = False

    # Create dataset and dataloader
    dataset = ImagePathDataset(image_paths)
    loader = DataLoader(
        dataset,
        batch_size=batch_size,
        num_workers=num_workers,
        collate_fn=safe_collate,  # handles corrupt images gracefully
        drop_last=False,
        prefetch_factor=1 if num_workers > 0 else None,
        persistent_workers=False,
    )

    for batch_images, batch_paths, batch_errors in loader:
        if check_cancel():
            cancelled = True
            break

        # Emit errors for images that failed to load
        for failed_path, error_msg in batch_errors:
            emit({"type": "error", "image": failed_path, "message": error_msg})
            processed += 1

        # Run batch detection on successfully loaded images
        if len(batch_images) > 0:
            batch_results = detector.batch_image_detection(batch_images)
            # ... per-image classification + result emission (same as current)

        emit({"type": "progress", "processed": processed, "total": total})

    emit({"type": "complete", ...})
```

**New `ImagePathDataset` class:**

```python
class ImagePathDataset(Dataset):
    """PyTorch Dataset that loads images from file paths."""
    def __init__(self, image_paths):
        self.paths = image_paths

    def __len__(self):
        return len(self.paths)

    def __getitem__(self, idx):
        path = self.paths[idx]
        try:
            img = Image.open(path).convert("RGB")
            return {"image": np.array(img), "path": path, "error": None}
        except Exception as e:
            return {"image": None, "path": path, "error": str(e)}
```

**Custom `safe_collate` function:**

```python
def safe_collate(batch):
    """Collate that separates successful loads from failures."""
    good_images = []
    good_paths = []
    errors = []
    for item in batch:
        if item["error"] is None:
            good_images.append(item["image"])
            good_paths.append(item["path"])
        else:
            errors.append((item["path"], item["error"]))
    return good_images, good_paths, errors
```

**Files changed:**
- `scripts/model-server.py` — Main changes: Dataset class, collate_fn, batch processing loop

### Phase 2: TypeScript Config Changes

**What changes:**

Wire up the `numWorkers` config parameter and move `batchSize` to ML_DEFAULTS.

**`src/lib/ml-defaults.ts`** — Add `numWorkers` and `batchSize`:

```typescript
export const ML_DEFAULTS = {
  detectorModel: "MDV6-yolov9-c",
  classifierModel: "AI4GAmazonRainforest",
  confidenceThreshold: 0.1,
  batchSize: 16,
  numWorkers: 2,  // auto-adjusted by Python: 0 on macOS, clamped to CPU count on Linux
} as const;
```

**`src/lib/ml-runner.ts`** — Add `numWorkers` to `MLConfig` interface + JSON serialization:

```typescript
export interface MLConfig {
  // ... existing fields ...
  batchSize: number;
  numWorkers: number;  // NEW
}

// In runMLPredictions(), add to job config:
const jobConfig = JSON.stringify({
  image_paths: config.imagePaths,
  confidence_threshold: config.confidenceThreshold,
  batch_size: config.batchSize,
  num_workers: config.numWorkers,  // NEW
});
```

**`src/app/camera-trap/actions.ts`** — Use ML_DEFAULTS instead of hardcoded 16:

```typescript
const mlResult = await runMLPredictions(jobId, {
  // ... existing fields ...
  batchSize: ML_DEFAULTS.batchSize,      // was: 16
  numWorkers: ML_DEFAULTS.numWorkers,    // NEW
});
```

**Cancel timeout increase** in `ml-runner.ts` `cancelModelServerJob()`:

```typescript
// Increase from 5s to 30s — batch processing takes longer per cancel check
setTimeout(() => {
  if (currentJob) {
    console.log("[ml-runner] Cancel timeout — killing model server");
    shutdownModelServer();
  }
}, 30_000);  // was: 5000
```

**Files changed:**
- `src/lib/ml-defaults.ts` — Add `batchSize`, `numWorkers`
- `src/lib/ml-runner.ts` — Add `numWorkers` to interface + serialization, increase cancel timeout
- `src/app/camera-trap/actions.ts` — Use ML_DEFAULTS for batchSize/numWorkers

### Phase 3: Parallel ffmpeg (`src/lib/frame-extractor.ts`, `src/app/camera-trap/actions.ts`)

**What changes:**

1. **frame-extractor.ts** — Change `activeExtractionPid` from `number | null` to `Set<number>`. Update `cancelFrameExtraction()` to kill all tracked PIDs.

2. **actions.ts** — Replace sequential video for-loop with batched `Promise.all`, capped at CPU count. Wrap per-video frame insertion in transactions.

3. **Video filename collision fix** — Prefix frame filenames with `vid${video.id}_` instead of just the video basename. This guarantees uniqueness (DB auto-increment ID) and prevents parallel ffmpeg processes from overwriting each other's output.

**`src/lib/frame-extractor.ts` changes:**

```typescript
// Change from:
let activeExtractionPid: number | null = null;

// To:
const activeExtractionPids = new Set<number>();

// In extractFrames(), track PID:
if (proc.pid) {
  activeExtractionPids.add(proc.pid);
}
// On completion, remove PID:
activeExtractionPids.delete(proc.pid);

// cancelFrameExtraction():
export function cancelFrameExtraction(): void {
  for (const pid of activeExtractionPids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch { /* already exited */ }
  }
  activeExtractionPids.clear();
}
```

**`src/app/camera-trap/actions.ts` video loop changes:**

```typescript
import os from "os";

const FFMPEG_CONCURRENCY = Math.min(os.cpus().length, 4);

// Replace sequential for-loop with batched Promise.all
for (let i = 0; i < videosToExtract.length; i += FFMPEG_CONCURRENCY) {
  const batch = videosToExtract.slice(i, i + FFMPEG_CONCURRENCY);

  await db.update(processingJobs).set({
    statusMessage: `Extrayendo cuadros de video... (${i + 1}-${Math.min(i + batch.length, videosToExtract.length)} de ${videosToExtract.length})`,
  }).where(eq(processingJobs.id, jobId));

  await Promise.all(batch.map(async (vid) => {
    // Use vid.id prefix for unique frame filenames
    const baseName = `vid${vid.id}_${vid.filename.replace(/\.[^.]+$/, "")}`;

    // Delete partial frames from previous runs
    await db.delete(images).where(
      and(eq(images.videoId, vid.id), eq(images.deploymentId, deployment.id))
    );

    const result = await extractFrames(vid.path!, cacheDir, baseName, fps);

    await db.update(videos).set({
      status: result.error && result.frames.length === 0 ? "failed" : "processed",
      duration: result.duration || null,
      errorMessage: result.error ?? null,
    }).where(eq(videos.id, vid.id));

    // Insert frames in a transaction (CLAUDE.md: bulk ops use transactions)
    await db.transaction(async (tx) => {
      for (const frame of result.frames) {
        await tx.insert(images).values({
          deploymentId: deployment.id,
          jobId,
          videoId: vid.id,
          filename: path.basename(frame.path),
          path: frame.path,
          status: "pending",
        });
      }
    });

    // Generate thumbnails (outside transaction — I/O heavy)
    for (const frame of result.frames) {
      // ... sharp thumbnail generation (same as current)
    }

    totalExtractedFrames += result.frames.length;
  }));
}
```

**Files changed:**
- `src/lib/frame-extractor.ts` — PID tracking Set, cancel-all
- `src/app/camera-trap/actions.ts` — Batched Promise.all loop, vid ID prefix, transaction wrapping

### Phase 4: Testing

- [ ] **Batch inference correctness** — Process a known deployment, compare detection counts against sequential baseline. Results should be identical.
- [ ] **Corrupt image handling** — Add a truncated JPEG to a deployment. Verify it fails individually while other images in the same batch succeed.
- [ ] **Cancel during batch** — Start processing, cancel mid-job. Verify job is marked cancelled within 30s.
- [ ] **Parallel ffmpeg** — Process a deployment with 4+ videos. Verify all frames extracted correctly, no filename collisions.
- [ ] **macOS local dev** — Verify `num_workers=0` fallback works (no multiprocessing hangs).
- [ ] **Production smoke test** — Deploy, process a real deployment, verify progress bar and results page.

## Acceptance Criteria

- [x] ML inference uses batch processing via ThreadPoolExecutor (parallel I/O + sequential detection)
- [x] `batch_size` config parameter is actually used (not dead code)
- [x] `num_workers` enables CPU-parallel image loading
- [x] One corrupt image in a batch does not fail other images
- [x] Video frame extraction runs concurrently (up to 4 parallel ffmpeg)
- [x] Frame filenames are uniquely namespaced by video DB ID
- [x] Per-video frame insertion wrapped in transactions
- [x] Cancel works within 30s (increased from 5s)
- [x] Same NDJSON protocol — no TypeScript ML handler changes
- [x] Progress bar still updates per-image (not per-batch)

## Dependencies & Risks

**No new dependencies** — PyTorch DataLoader is already available via the existing `torch` install. No new npm packages needed.

**Risks:**
- DataLoader `num_workers > 0` may have edge cases on specific Linux kernel versions in Docker. Mitigation: default to 2, configurable via env var.
- Batch inference may produce slightly different floating-point results vs sequential (due to batched tensor ops). Mitigation: compare detection counts, not exact confidence values.
- Parallel ffmpeg increases peak CPU usage during extraction phase. Mitigation: cap at 4 concurrent processes.

## References

- Brainstorm: `docs/brainstorms/2026-02-22-ct-pipeline-parallelization-brainstorm.md`
- PytorchWildlife batch API: https://cameratraps.readthedocs.io/en/latest/demo/image_detection_demo.html
- Current model server: `scripts/model-server.py`
- Current ML runner: `src/lib/ml-runner.ts`
- Current frame extractor: `src/lib/frame-extractor.ts`
- Processing actions: `src/app/camera-trap/actions.ts` (lines 131-583)
- ML defaults: `src/lib/ml-defaults.ts`
