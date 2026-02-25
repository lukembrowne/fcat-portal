# Passive Audio Recorder Module — Brainstorm

**Date:** 2026-02-24
**Status:** Design captured

## What We're Building

A top-level audio module (`/audio/`) — "Grabaciones" in the nav — for browsing, playing, and eventually processing passive audio recordings from field deployments. Audio recorders are paired with camera traps at the same sites, so they share the same deployment infrastructure, Drive folders, and ODK metadata.

### MVP Scope (Phase 1)
- Track which deployments have audio files uploaded to Drive
- Browse audio files per deployment with basic metadata (duration, timestamps, format)
- Stream/play audio files directly in the browser
- Use the same `ct_projects` permission system as camera traps

### Future Scope (Phase 2+)
- BirdNET integration for automated species identification (same server as MegaDetector)
- Processing job lifecycle (create → process → verify results)
- Species annotation and verification workflow (unverified → verified/rejected/corrected)
- Starring/favorites for notable recordings
- Species summaries and statistics
- Spectrogram visualization (approach TBD)

## Why This Approach

### Decision: Separate top-level module with shared code

**Rejected alternatives:**
1. **Merge into camera traps module** — Camera trap module is already ~3000 lines in `actions.ts`. Workflows are separate (different people review audio vs. photos at different times). "Camera trap" name becomes misleading.
2. **BioChoco sub-module (`/biochoco/audio/`)** — Audio is BioChoco-specific today, but the feature set (processing, species ID, verification) mirrors camera traps more than iButton. A top-level module keeps it symmetrical with camera traps and gives room to grow.

**Chosen approach: Top-level `/audio/` module** that:
- Has its own route tree and UI, separate from camera traps
- Shares the same deployment records and `ct_projects` permission system
- Shares components from `src/components/` (species combobox, verification toolbar, progress tracker)
- Has audio-specific DB tables for files and detections
- Has an audio player for in-browser streaming instead of image viewer with bounding boxes

## Key Decisions

### 1. URL & Navigation
- Route: `/audio/`
- Spanish nav label: **Grabaciones**
- Symmetrical with `/camera-trap/` as its own top-level section

### 2. Access Control
Same `ct_projects` system as camera traps. Since audio shares the same deployments, project access naturally applies to both. If you can see a project's camera trap deployments, you can see their audio data.

### 3. Database Schema

**New tables:**
- `audio_files` — Individual recordings (duration, sample_rate, format, file_size, deployment_id, drive_file_id, timestamps)
- `audio_detections` — Temporal segments from BirdNET (start_time, end_time, frequency_low, frequency_high, confidence, class_label)
- `audio_identifications` — Species per detection (species_id, verification_status, verified_by, model_name, confidence)

**Reuse existing tables:**
- `biochoco_deployments` — Same deployments, no changes
- `biochoco_species` — Same species table for birds, mammals, everything
- Processing jobs: TBD — add `media_type` to existing table or create `audio_processing_jobs`

Separate identification tables per media type (not polymorphic). Cleaner Drizzle types, simpler queries. Cross-media species reports use UNION when needed.

### 4. Component Reuse Strategy

| Reuse as-is | Adapt for audio | Build new |
|---|---|---|
| Species combobox | Verification toolbar | Audio player (in-browser streaming) |
| Processing progress tracker | Deployments table (audio columns) | Audio detection timeline |
| Species sidebar | Results table (time-based vs bbox) | |
| Starring/favorites logic | Job creation form (BirdNET config) | |
| Status badges | | |

### 5. Processing Pipeline (BirdNET, future)
Same server as MegaDetector, same pattern:
1. Create job → link audio files → set status "pending"
2. Download audio from Drive to temp directory
3. Run BirdNET → temporal detections with species confidence
4. Store detections + identifications to DB
5. Verification workflow (same states: unverified → verified/rejected/corrected)

Key difference: BirdNET outputs time segments + frequency ranges, not bounding boxes.

## Open Questions

1. **Audio streaming** — Proxy through portal (access control + consistent API, more server load for large files) vs. signed Drive download URLs (less server load, more complex auth)?
2. **Spectrogram** — Generate server-side (Python, cached) vs. client-side (Web Audio API)? Or defer entirely until BirdNET phase?
3. **Processing jobs table** — Add `media_type` to existing `biochoco_processing_jobs` or separate `audio_processing_jobs`?
4. **Audio file formats** — What formats do the recorders produce? (WAV, MP3, FLAC?) Affects storage, streaming, and browser compatibility.
