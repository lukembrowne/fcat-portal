# Camera Trap Video Processing

**Date**: 2026-02-14
**Status**: Decided

## What We're Building

Support for processing camera trap videos alongside images in the existing ML pipeline. Videos live in the same Google Drive deployment folders as images (~50/50 mix). They're typically short motion-triggered clips (5-30 seconds).

**Goals:**
- Detect and scan video files during Drive sync
- Extract frames at a configurable rate (e.g., 1 frame/second)
- Run the same MegaDetector + classifier pipeline on extracted frames
- Frame-level detections feed into the existing verification workflow
- Group frames by source video in the results UI

## Why This Approach

**Chosen: Pre-extract frames with ffmpeg, feed as images to unchanged ML pipeline (Approach 1)**

Rejected alternatives:
- **Extend Python model server for video**: PytorchWildlife's `pw_utils.process_video()` is designed for producing annotated output videos, not extracting detections into a database. Would require significant model server changes and tighter coupling to PytorchWildlife's video API. Configurable FPS is harder since `target_fps` controls output, not extraction rate.
- **Hybrid lazy extraction during ML**: Mixes concerns (download, extract, ML) in one step. Harder to track progress and debug failures.

**Why Approach 1 wins:**
- Zero changes to the Python model server — frames are just images
- Full control over extraction rate via ffmpeg parameters
- Short clips at 1fps = 5-30 frames, minimal disk usage
- Existing verification UI works on frames with no changes
- ffmpeg is battle-tested and available in Docker
- Simple to understand, debug, and maintain

## Key Decisions

1. **Frame extraction tool**: ffmpeg (available in Docker, fast, reliable)
2. **Extraction rate**: Configurable per processing job (default 1 fps). User can choose 1 frame every N seconds.
3. **Storage**: Extracted frames saved as JPEGs in the same image cache (`data/cache/ct-images/{deploymentId}/`)
4. **ML pipeline**: No changes — extracted frames are just image files
5. **DB schema**: Track video files and link extracted frames back to source video
6. **Results UI**: Group frames by source video in the results table (simple grouping, no aggregation for now)
7. **Video file types**: `.mp4`, `.avi`, `.mov` (common camera trap formats)

## Schema Design (Sketch)

**Option A — Extend `biochoco_images`:**
- Add `mediaType` column: `image` | `video_frame`
- Add `sourceVideoId` FK (self-referential or to a separate videos table)
- Video files themselves get a row with `mediaType: 'video'` (or a separate table)

**Option B — Separate `biochoco_videos` table:**
- New table for video metadata (filename, driveFileId, duration, fps, etc.)
- `biochoco_images` gets `videoId` FK for extracted frames
- Cleaner separation but more joins

Decision on exact schema deferred to planning phase.

## Processing Flow (Sketch)

1. **Scan**: `listFilesRecursive()` picks up video files by MIME type/extension → stored as video records
2. **Download**: Videos downloaded to cache alongside images
3. **Extract**: ffmpeg extracts frames at configured FPS → saved as `{video_filename}_frame_{N}.jpg`
4. **Process**: Extracted frame paths sent to ML model server as regular image paths
5. **Store**: Detections/identifications stored per frame, linked back to source video
6. **Display**: Results table groups frames under their parent video

## Open Questions

- Should we store the original video file long-term or only the extracted frames?
- Do we want a "play video" button in the results UI eventually, or is frame-by-frame review sufficient?
- What's the maximum video file size we should support downloading from Drive?
- Should frame extraction happen during the download phase or as a separate step before ML processing?
