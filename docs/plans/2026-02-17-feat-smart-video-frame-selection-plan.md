---
title: "feat: Smart detection-based frame selection for camera trap videos"
type: feat
date: 2026-02-17
---

# Smart Detection-Based Frame Selection for Camera Trap Videos

## Overview

Enhance the camera trap video processing pipeline with a two-pass approach: extract frames at a higher rate (4fps instead of 1fps) for better temporal coverage of brief animal appearances, then use MegaDetector detection confidence to select only the top N frames per video for full species classification. This directly improves accuracy — animals that appear for less than a second are far more likely to be captured and classified.

## Problem Statement

**Current behavior:** Videos are extracted at 1fps (default), producing 5-30 frames per typical 5-30 second clip. ALL frames go through the full pipeline (MegaDetector detection + AI4GAmazonRainforest classification). At 1fps, an animal that darts through the frame in under a second may be captured in 0-1 frames, or caught at a bad angle/with motion blur.

**What the research shows:** The camera trap ML literature (Zamba, MegaDetectorLite) converges on a two-tier approach:

1. Extract at a higher rate (~4fps) for better temporal coverage
2. Score all frames with a fast detector
3. Select the top N frames (typically 16) with highest detection probability
4. Run the expensive classifier only on selected frames
5. Aggregate predictions per video

**Why this matters for FCAT:** Our Chocó cloud forest deployments capture fast-moving species (birds, small mammals) where 1fps often misses the clearest frame. Extracting more frames and intelligently selecting the best ones means fewer missed detections and higher-confidence classifications.

## Proposed Solution

Adapt the two-pass approach to our existing PytorchWildlife + MegaDetector V6 pipeline. We don't need MegaDetectorLite (a separate Zamba ecosystem dependency) — our MegaDetector V6 is already loaded and can serve as both the scoring detector and the final detector. The key insight: **skip classification on low-value frames**, since classification (cropping + running through AI4GAmazonRainforest) is the expensive per-detection step.

### High-Level Flow (Video Frames Only)

```
Extract at 4fps ──► MegaDetector detection-only on ALL frames
                           │
                    Score each frame (max detection confidence)
                           │
                    Select top 16 frames per video
                           │
              Full detection + classification on selected frames
                           │
                    Store results in DB (only selected frames)
```

Regular images (not from videos) continue through the existing single-pass pipeline unchanged.

### Computational Impact

For a deployment with 20 videos of 30s each:

| Metric | Current (1fps, single pass) | New (4fps, two-pass) |
|--------|---------------------------|---------------------|
| Frames extracted | 600 | 2,400 |
| Detection runs | 600 | 2,400 + 320 = 2,720 |
| Classification runs | ~200 (only animal detections) | ~100 (top 16 × 20 videos, only animals) |
| Frames in DB | 600 | 320 |
| Drive uploads | 600 | 320 |
| **Net effect** | Baseline | ~2x more detection, ~2x less classification, **4x better temporal coverage** |

Detection is cheaper than classification per image, so total processing time increases modestly while accuracy improves significantly.

## Technical Approach

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   actions.ts (orchestrator)               │
│                                                           │
│  1. extractFrames() at 4fps → temp paths (no DB rows)    │
│  2. runDetectionScoring(tempPaths) → scores per frame     │
│  3. selectTopFrames(scores, videoGroups, N=16) → winners  │
│  4. Create image DB rows for winners only                 │
│  5. Upload winners to Drive                               │
│  6. runMLPredictions(winnerPaths) → full results          │
│  7. Clean up non-selected temp frames                     │
└─────────────────────────────────────────────────────────┘
        │                           │
        ▼                           ▼
┌───────────────┐          ┌──────────────────┐
│ frame-extractor│          │   model-server.py │
│  (ffmpeg)      │          │                    │
│  4fps default  │          │  detect_only mode  │
│  cap: 600      │          │  + existing mode   │
└───────────────┘          └──────────────────┘
```

### Implementation Phases

#### Phase 1: Model Server — Detection-Only Mode

**File:** `scripts/model-server.py`

Add support for a `detect_only` flag in the job config. When set, the server runs MegaDetector detection but skips classification entirely, returning a lightweight score per image.

**New protocol message:**

```
-> {"image_paths": [...], "detect_only": true, "confidence_threshold": 0.01}
<- {"type": "score", "image": "path/frame.jpg", "max_confidence": 0.87, "num_detections": 2}
<- {"type": "score", "image": "path/frame2.jpg", "max_confidence": 0.0, "num_detections": 0}
...
<- {"type": "complete", "total_processed": 120, "total_detections": 45}
```

Changes to `process_job()`:

```python
def process_job(config, detector, classifier):
    detect_only = config.get("detect_only", False)
    # ... existing detection loop ...

    if detect_only:
        # Return score summary instead of full detections
        max_conf = max((float(c) for c in sv_detections.confidence), default=0.0)
        emit({
            "type": "score",
            "image": image_path,
            "max_confidence": round(max_conf, 4),
            "num_detections": len([c for c in sv_detections.confidence if c >= confidence_threshold]),
        })
    else:
        # Existing behavior: detection + classification
        # ... no changes ...
```

**Backward compatible:** If `detect_only` is absent or false, behavior is identical to current.

- [ ] Add `detect_only` flag parsing in `process_job()`
- [ ] Emit `"score"` message type for detection-only mode (skip classification loop)
- [ ] Use low confidence threshold (0.01) for scoring to catch faint detections
- [ ] Keep cancel support working in detection-only mode

#### Phase 2: ML Runner — Two-Pass Orchestration

**File:** `src/lib/ml-runner.ts`

Add a new function `runDetectionScoring()` that sends a detection-only job and collects scores. Add `selectTopFrames()` for the selection logic.

```typescript
// src/lib/ml-runner.ts

interface FrameScore {
  path: string;
  maxConfidence: number;
  numDetections: number;
}

/**
 * Run detection-only scoring on a set of image paths.
 * Returns scores without storing anything in the DB.
 */
export async function runDetectionScoring(
  imagePaths: string[],
  confidenceThreshold: number = 0.01
): Promise<FrameScore[]> { ... }

/**
 * Select top N frames per video based on detection scores.
 * Groups frames by videoId, picks top N by maxConfidence per group.
 * Guarantees at least 1 frame per video (even if score is 0).
 */
export function selectTopFrames(
  scores: FrameScore[],
  videoFrameGroups: Map<number, string[]>,  // videoId → frame paths
  topN: number = 16
): Map<number, string[]> { ... }  // videoId → selected frame paths
```

Changes to NDJSON handler:

- [ ] Handle new `"score"` message type (collect scores, don't write to DB)
- [ ] Add `runDetectionScoring()` function — sends `detect_only: true` job, returns `FrameScore[]`
- [ ] Add `selectTopFrames()` — pure function, groups by video, selects top N by `maxConfidence`
- [ ] Ensure scoring job doesn't interfere with `currentJob` state (it IS a job, just lighter)

#### Phase 3: Frame Extraction Updates

**File:** `src/lib/frame-extractor.ts`

- [ ] Raise `MAX_FRAMES_DEFAULT` from 300 to 600 (4fps × 150s max practical video)
- [ ] No other changes needed — FPS is already configurable via `extractFrames(path, dir, name, fps)`

**File:** `src/lib/ml-defaults.ts`

- [ ] Add `frameExtractionRate: 4.0` to `ML_DEFAULTS` (was implicitly 1.0)
- [ ] Add `framesPerVideo: 16` to `ML_DEFAULTS`

```typescript
export const ML_DEFAULTS = {
  detectorModel: "MDV6-yolov9-c",
  classifierModel: "AI4GAmazonRainforest",
  confidenceThreshold: 0.1,
  frameExtractionRate: 4.0,
  framesPerVideo: 16,
} as const;
```

#### Phase 4: Processing Job Orchestration

**File:** `src/app/camera-trap/actions.ts`

Restructure the video frame processing section of `processJobInternal()`:

**Current flow (lines ~237-397):**
1. Extract frames → create image DB rows immediately → thumbnails → upload to Drive
2. Later: send ALL image paths to ML

**New flow:**
1. Extract frames at 4fps → collect temp paths (NO DB rows yet)
2. Send temp paths for detection-only scoring
3. Select top N per video
4. Create image DB rows only for selected frames
5. Generate thumbnails for selected frames
6. Upload selected frames to Drive
7. Send selected frame paths for full classification

```typescript
// Pseudocode for the new video processing section in processJobInternal()

if (videosToExtract.length > 0) {
  const fps = job.frameExtractionRate ?? ML_DEFAULTS.frameExtractionRate;
  const topN = ML_DEFAULTS.framesPerVideo;

  // Step 1: Extract ALL frames to temp (no DB rows)
  const videoFrameGroups = new Map<number, string[]>();  // videoId → paths
  const allTempPaths: string[] = [];

  for (const vid of videosToExtract) {
    const result = await extractFrames(vid.path!, cacheDir, baseName, fps);
    const paths = result.frames.map(f => f.path);
    videoFrameGroups.set(vid.id, paths);
    allTempPaths.push(...paths);
    // Update video duration but DON'T create image rows yet
  }

  // Step 2: Detection-only scoring
  await updateJobStatus(jobId, "Analizando cuadros de video...");
  const scores = await runDetectionScoring(allTempPaths);

  // Step 3: Select top N per video
  const selected = selectTopFrames(scores, videoFrameGroups, topN);
  const selectedPaths = new Set([...selected.values()].flat());

  // Step 4: Create image DB rows for selected frames only
  for (const [videoId, paths] of selected) {
    for (const framePath of paths) {
      await db.insert(images).values({
        deploymentId: deployment.id,
        jobId,
        filename: path.basename(framePath),
        path: framePath,
        videoId,
        frameIndex: extractFrameIndex(framePath),
        status: "pending",
      });
      // Thumbnail generation...
    }
  }

  // Step 5: Upload selected frames to Drive
  // (existing upload logic, just fewer frames)

  // Step 6: Clean up non-selected temp frames
  for (const tempPath of allTempPaths) {
    if (!selectedPaths.has(tempPath)) {
      await fs.unlink(tempPath).catch(() => {});
    }
  }

  // Step 7: Update job counts
  await db.update(processingJobs).set({
    extractedFrames: allTempPaths.length,
    totalImages: sql`${processingJobs.totalImages} + ${selectedPaths.size}`,
  }).where(eq(processingJobs.id, jobId));
}

// Later: runMLPredictions() processes only the selected frames
```

- [ ] Restructure video extraction section — extract first, score, select, then persist
- [ ] Update status messages for new phases ("Analizando cuadros...", "Seleccionando mejores cuadros...")
- [ ] Clean up non-selected frames from cache
- [ ] Update job stats (extractedFrames = total extracted, totalImages = only selected)

#### Phase 5: Schema + Migration

**File:** `src/db/schema.ts`

Add `framesPerVideo` to `processingJobs`:

```typescript
// In processingJobs table definition
framesPerVideo: integer("frames_per_video").default(16),
```

**File:** `scripts/push-schema.mjs`

- [ ] Add migration: `ALTER TABLE biochoco_processing_jobs ADD COLUMN frames_per_video INTEGER DEFAULT 16`

No changes needed to `biochoco_images`, `biochoco_detections`, or `biochoco_identifications` — selected frames go through the existing pipeline identically.

#### Phase 6: UI Updates (Minimal)

**File:** `src/app/camera-trap/[id]/process-button.tsx`

- [ ] Display the new defaults in processing config (4fps, 16 frames per video) if showing settings

**File:** `src/app/camera-trap/results/[id]/results-client.tsx` (or page.tsx)

- [ ] Add video summary info: "N cuadros analizados de M extraídos" per video group
- [ ] No structural changes — selected frames display exactly like current frames

**Job progress messages** (already handled by actions.ts status updates):
- "Extrayendo cuadros de video... (2 de 5)"
- "Analizando cuadros de video... (120 de 480)"
- "Seleccionando mejores cuadros... (16 por video)"
- "Clasificando especies... (32 de 64)"

## Alternative Approaches Considered

### 1. MegaDetectorLite (Zamba's Approach)
**Rejected.** MegaDetectorLite is from the Zamba ecosystem (drivendata), not PytorchWildlife. Adding it would mean a new dependency chain, separate model weights, and a different inference API. Our MegaDetector V6 is already loaded and can score frames effectively — adding a second detector model doubles memory usage for marginal speed improvement on our small batch sizes.

### 2. Single Pass + Post-hoc Filtering
Run full detection + classification on all 4fps frames, then hide low-value frames in the UI. **Rejected** because classification is the expensive step (~2x detection cost per image due to cropping + separate model). For 2,400 frames, this wastes significant compute on frames that will be discarded.

### 3. Uniform Sampling at Higher FPS Without Selection
Just bump to 4fps and process everything. **Rejected** because it 4x the processing time, 4x the DB rows, and 4x the Drive storage, while overwhelming reviewers with redundant frames of the same animal in the same position.

### 4. Single "Best Frame" Per Video
Select only the 1 frame with highest detection confidence. **Rejected** per the research — one frame may capture the animal at a bad angle, partially occluded, or blurred. Multiple frames allow for cross-validation of species identification.

### 5. Modify Python Server to Handle Everything Internally
Have the model server do extraction + scoring + selection + classification in one shot. **Rejected** because it mixes concerns (ffmpeg + ML), makes the Python server much more complex, and breaks the current clean separation between frame extraction (Node.js/ffmpeg) and ML inference (Python).

## Edge Cases & Design Decisions

These were identified via SpecFlow analysis and must be addressed during implementation:

### Scoring Failures

- **Partial scoring failure:** If `runDetectionScoring` fails partway through (model server crash), **fail the job immediately**. Clean up all temp frames in the catch handler. Partial-score fallback adds complexity for marginal benefit — it's safer to fail fast and let the user retry.
- **Individual frame error during scoring:** If a single frame fails to load in detect-only mode (corrupt JPEG from ffmpeg), the Python server emits the existing `{"type": "error", "image": path}` message. The TypeScript collector treats errored frames as `{ maxConfidence: 0.0, numDetections: 0 }` — they can still participate in the "at least 1 per video" fallback.
- **`currentJob` singleton:** The scoring pass uses the same `currentJob` / `serverStatus = "busy"` mechanism as the classification pass. It is a normal job to the model server — just lighter. Cancellation during scoring works identically to cancellation during classification.

### Frame Selection Edge Cases

- **All frames score 0 (vegetation/wind trigger):** Select the first frame (by `frameIndex`) as the representative. This is the frame closest to the motion trigger event.
- **Tie-breaking:** Sort by `maxConfidence` descending, then by `frameIndex` ascending (earlier frames preferred). This ensures temporal spread and determinism.
- **Fewer frames than topN:** If a 3-second video at 4fps produces 12 frames and `topN = 16`, select all 12. Clamp to `Math.min(topN, availableFrames)`.
- **Zero frames extracted (video <0.25s):** Follow existing behavior — mark video `status = "failed"`, log it, continue the job. The video simply has no entries in `videoFrameGroups`.
- **Long videos hitting 600-frame cap:** Log a warning (existing behavior). The first 150 seconds are sampled. Future: adaptive fps reduction for long videos.

### Reprocessing

- **Reprocessing a deployment at 4fps that was previously processed at 1fps:** `createProcessingJob` must DELETE existing video-frame image rows (`videoId IS NOT NULL`) for the deployment, since they'll be entirely replaced by the new selection. Regular still-image rows (`videoId IS NULL`) are reset to `pending` as before. This prevents duplicate frame rows.

### Consistency Fixes

- **`queueProcessing` fps default:** Fix `createProcessingJob`'s hardcoded `?? 1.0` fallback to `?? ML_DEFAULTS.frameExtractionRate` so batch-queued jobs are consistent with single-deployment jobs.
- **`framesPerVideo` in `modelConfig`:** Add `framesPerVideo` to the `modelConfig` parameter in `createProcessingJob` so the schema column is actually writable. Without this the column can only ever be the default 16.
- **Selected frame insertion order:** Insert selected frames in ascending `frameIndex` order so that `ORDER BY images.id` in the results UI gives temporal sequence.

### Progress Reporting

- **Scoring pass vs. classification pass:** Use distinct status messages:
  - "Evaluando cuadros de video... (120 de 480)" — during detection scoring
  - "Seleccionando mejores cuadros..."  — brief, after scoring
  - "Analizando imágenes... (N de M)" — during classification (includes both selected frames + still images)
- **Counter reset:** The processed-images counter resets between scoring and classification. The scoring pass updates `statusMessage` only (no `processedImages` counter update, since those frames aren't "processed" yet). The classification pass uses `processedImages` as it does today.

### Cancellation Across Two Passes

- **During frame extraction:** `cancelFrameExtraction()` kills ffmpeg. Temp frames on disk are in `cacheDir`, which is cleaned up by `cleanupJobTempDir()` in the error/cancel handler.
- **During scoring pass:** `cancelModelServerJob()` sends cancel to server. `runDetectionScoring` resolves with partial results (or rejects). Job is marked `cancelled`. Temp frames are in `cacheDir` → cleaned up by existing handler.
- **During classification pass:** Same as current behavior — no changes needed.
- **Key invariant:** Before selection, there are NO image DB rows for video frames. On cancel/failure, only temp files on disk need cleanup (handled by `cleanupJobTempDir`).

## Acceptance Criteria

### Functional Requirements

- [ ] Videos are extracted at 4fps by default (configurable)
- [ ] Detection-only scoring runs on all extracted frames
- [ ] Top 16 frames per video (configurable) are selected by detection confidence
- [ ] Only selected frames get full classification, DB rows, Drive uploads, and thumbnails
- [ ] Regular images (not from videos) are unaffected — same single-pass pipeline
- [ ] Non-selected frames are cleaned up from local cache
- [ ] Job progress messages reflect the two-pass flow
- [ ] At least 1 frame per video is always selected (even if all scores are 0)
- [ ] Reprocessing a deployment deletes old video-frame image rows before creating new ones
- [ ] Batch-queued jobs (`queueProcessing`) use 4fps consistently with single-deployment jobs

### Non-Functional Requirements

- [ ] Total processing time for a 20-video deployment is no more than 2x current (despite 4x frames)
- [ ] No new Python dependencies — uses existing MegaDetector V6
- [ ] Backward compatible — existing jobs and results are unaffected
- [ ] Model server protocol is backward compatible (detect_only defaults to false)

### Quality Gates

- [ ] Unit tests for `selectTopFrames()` — correct grouping, top-N selection, tie-breaking, edge cases (0 detections, fewer frames than N, single frame)
- [ ] Integration test for detection-only scoring round-trip (model server mock)
- [ ] Test reprocessing: verify old video-frame rows are deleted, new ones are created correctly
- [ ] E2E: process a deployment with videos, verify only top N frames per video appear in results

## Dependencies & Prerequisites

- ffmpeg already available in Docker (confirmed)
- MegaDetector V6 already loaded by model server (no new models)
- `biochoco_videos` table and `videoId`/`frameIndex` columns on `biochoco_images` already exist
- `frameExtractionRate` column already on `biochoco_processing_jobs`

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Detection-only mode breaks model server | Low | High | Backward-compatible flag; existing tests still pass |
| 4fps extraction overwhelms disk | Low | Medium | 600 frame cap; temp frames cleaned up after selection |
| All frames score 0 (e.g., vegetation trigger) | Medium | Low | Always select at least 1 frame per video; "no detections" is a valid result |
| Two-pass doubles total processing time | Medium | Medium | Detection-only pass is ~50% faster than full pass; net increase is modest |
| Cancel during scoring pass | Low | Medium | Reuse existing cancel protocol; scoring pass respects `check_cancel()` |

## Future Considerations

- **Per-video species aggregation:** Once we have top-N frames classified, aggregate into a single per-video species prediction (majority vote / weighted average). This is a separate follow-up feature.
- **Temporal deduplication:** If multiple consecutive frames show the same animal in the same position, keep only the sharpest one. Requires image quality metrics (Laplacian variance for blur detection).
- **Adaptive N:** Instead of fixed 16, select all frames above a detection confidence threshold. Would catch more in high-activity videos and fewer in quiet ones.
- **MegaDetectorLite future option:** If PytorchWildlife adds a lightweight scoring model, it could replace MegaDetector V6 for the scoring pass, further reducing compute.

## References

### Internal References
- Brainstorm: `docs/brainstorms/2026-02-14-camera-trap-video-processing-brainstorm.md`
- ML runner: `src/lib/ml-runner.ts`
- Model server: `scripts/model-server.py`
- Frame extractor: `src/lib/frame-extractor.ts`
- Processing actions: `src/app/camera-trap/actions.ts`
- ML defaults: `src/lib/ml-defaults.ts`
- Schema: `src/db/schema.ts` (lines 82-239)

### External References
- Zamba frame selection approach (16 frames, MegaDetectorLite scoring): drivendata/zamba
- MegaDetector V6 (our detector): microsoft/CameraTraps
- PytorchWildlife (our ML framework): microsoft/pytorch-wildlife
- Camera trap video processing literature: frame selection matters more than frame count
