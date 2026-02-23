# Camera Trap Pipeline Parallelization

**Date:** 2026-02-22
**Status:** Ready for planning

## What We're Building

Speed up the camera trap ML processing pipeline by:
1. Switching from sequential single-image inference to batch inference with multi-CPU image loading
2. Parallelizing video frame extraction (ffmpeg) across available CPUs

## Why This Approach

The current pipeline processes images **one at a time** via `single_image_detection()` in a Python for-loop. The `batch_size` config parameter is sent from TypeScript but completely ignored in `model-server.py`. PytorchWildlife natively supports batch detection via DataLoader with `num_workers` for CPU-parallel image loading and `batch_size` for batched model inference.

**Expected impact on 4-CPU production server:**
- `num_workers=4` parallelizes image loading/preprocessing across all CPUs
- `batch_size=16` batches images through MegaDetector (better CPU cache utilization, less Python overhead per image)
- Parallel ffmpeg uses idle CPUs during video-heavy deployments

## Key Decisions

### 1. Mini-batch approach (not full DataLoader refactor)
Keep the Python for-loop structure but process in chunks of `batch_size`:
- Load `batch_size` images → run batch detection → emit per-image results → check cancel → repeat
- **Same NDJSON protocol** — zero TypeScript changes needed
- Progress updates emit per-batch instead of per-image (chunkier but still meaningful)

### 2. DataLoader with num_workers for image loading
Use PyTorch DataLoader to parallelize the CPU-bound image loading/preprocessing:
- `num_workers` = CPU count (4 in prod, 10-12 locally)
- Workers pre-load and transform images in parallel while the model processes the current batch
- This is the standard PyTorch pattern for CPU-bound data pipelines

### 3. Classification stays per-crop (for now)
After batch detection, animal crops are still classified individually via `single_image_classification()`. Batching classification is a future optimization — detection is the heavier operation.

### 4. Parallel ffmpeg (TypeScript side)
The sequential `for` loop over videos in `actions.ts` becomes concurrent with a cap:
- Use a simple concurrency limiter (e.g., process up to N videos simultaneously)
- N = min(CPU count, number of videos)
- Each ffmpeg process is already efficient; we're just running multiple in parallel

## Scope

### In scope
- `model-server.py`: Replace sequential `single_image_detection()` loop with mini-batch processing using DataLoader
- `model-server.py`: Wire up the `batch_size` and add `num_workers` config params
- `actions.ts`: Parallelize video frame extraction loop
- `ml-runner.ts`: Pass `num_workers` config (minor)
- `ml-defaults.ts`: Add `numWorkers` default

### Out of scope (future optimizations)
- DB write batching (individual INSERTs per detection stay as-is)
- Batch classification of animal crops
- Multi-process model servers (multiple Python processes)
- Job-level parallelism (multiple deployments processing simultaneously)

## Open Questions

1. What `batch_size` default works best? 16 is a reasonable start for CPU inference. Too large = memory pressure, too small = less throughput.
2. Should `num_workers` be auto-detected from `os.cpu_count()` or a configurable env var? Auto-detect with env var override seems safest.
3. For parallel ffmpeg, what's the right concurrency cap? CPU count is reasonable since ffmpeg is CPU-bound.

## Architecture

```
Current:  image1 → detect → classify → result → image2 → detect → ...
Proposed: [batch of 16 images] → DataLoader(num_workers=4) loads in parallel
          → batch detect → per-image classify → emit results → next batch
```

```
Current:  video1 → ffmpeg → video2 → ffmpeg → video3 → ffmpeg
Proposed: video1 → ffmpeg ─┐
          video2 → ffmpeg ─┤ (concurrent, capped at CPU count)
          video3 → ffmpeg ─┘
```
