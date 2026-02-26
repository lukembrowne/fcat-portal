---
title: "Audio Annotation Interface with Spectrograms"
date: 2026-02-25
type: feat
---

# Audio Annotation Interface with Spectrograms

## What We're Building

A bioacoustics annotation interface for audio recordings, modeled after Raven Pro. Users view a full-file spectrogram and draw time-frequency bounding boxes to label species calls and other sounds. The annotation data should be useful for training ML models (like BirdNET) in the future.

The system mirrors the existing camera trap annotation workflow: detections (boxes) + identifications (species) + verification status, reusing the shared species list and sidebar component.

## Why This Approach

- **Time-frequency boxes** (not just time ranges) capture the spectral signature of each call, which is essential for ML training data and for distinguishing overlapping species
- **Server-side spectrogram generation** (Python/librosa) gives consistent, high-quality output that can be cached as PNG images. The ML Python venv already exists. Client-side generation would be memory-intensive for 60s WAV files and inconsistent across browsers
- **New audio-specific tables** (`audio_detections`, `audio_identifications`) keep the data model clean. Audio boxes have real-world units (seconds, Hz) that don't map cleanly to normalized image coordinates
- **Dedicated annotation page** (`/audio/[deploymentId]/annotate/[fileId]`) gives full-screen space for the spectrogram + species sidebar, matching the camera trap annotation UX

## Key Decisions

1. **Annotation type**: Time-frequency bounding boxes on spectrograms (Raven-style), stored with real units (startTime, endTime, minFreq, maxFreq)
2. **Spectrogram generation**: Server-side Python (librosa) → cached PNG alongside audio files in `data/cache/audio/{deploymentId}/`
3. **File caching**: On-demand download from Drive to local cache, same LRU eviction pattern as camera trap images, separate size limit (~50GB)
4. **Data model**: New `audio_detections` and `audio_identifications` tables, same verification workflow (unverified → verified/rejected/corrected)
5. **Species list**: Reuse existing `biochoco_species` table and `SpeciesSidebar` component
6. **Navigation**: Dedicated page per file at `/audio/[deploymentId]/annotate/[fileId]` with prev/next navigation
7. **First milestone**: Full end-to-end pipeline for a single file (cache + spectrogram + annotation UI + species assignment)

## Architecture Sketch

```
Audio File Page (/audio/[id])
  └─ Click "Anotar" on a file row
      └─ Annotation Page (/audio/[id]/annotate/[fileId])
          ├─ Server: download audio → cache → generate spectrogram PNG
          ├─ Layout: [SpeciesSidebar | Spectrogram + Controls]
          ├─ Spectrogram: full-file PNG, zoomable, with overlay SVG for boxes
          ├─ Box drawing: click-drag on spectrogram → audio_detection record
          ├─ Species assignment: sidebar click → audio_identification record
          └─ Playback: play selected region or full file
```

## Data Model

### `audio_detections` table
- `id`, `audioFileId`, `startTime` (seconds), `endTime` (seconds)
- `minFreq` (Hz), `maxFreq` (Hz)
- `confidence` (nullable, for future ML)
- `modelVersion` (nullable, for future ML)
- `createdBy`, `createdAt`

### `audio_identifications` table
- `id`, `audioDetectionId`
- `species` (scientific name from biochoco_species)
- `confidence` (nullable, for ML)
- `verificationStatus` (unverified | verified | rejected | corrected)
- `correctedSpecies`, `verifiedBy`, `verifiedAt`

## Spectrogram Generation

- Input: WAV file (cached locally)
- Tool: librosa (Python, in existing ML venv)
- Output: PNG image (full file, fixed height, width proportional to duration)
- Params: mel spectrogram, configurable FFT/hop size, frequency range
- Cache: `data/cache/audio/{deploymentId}/{filename}.spec.png`
- Trigger: on-demand when annotation page is opened (or pre-generate during scan)

## Reusable Components from Camera Trap

| Camera Trap | Audio Equivalent |
|---|---|
| `BBoxOverlay` (normalized coords, click-drag) | Adapt for time-freq coords on spectrogram |
| `SpeciesSidebar` (search, recent, hotkeys) | Reuse directly |
| `image-annotation-client.tsx` (layout, detection cards) | Reference for annotation page layout |
| `detections` + `identifications` tables | New audio-specific tables, same patterns |
| `drive-downloader.ts` (cache, LRU eviction) | Adapt for audio file caching |
| Verification workflow (verify/reject/correct) | Reuse logic |

## Open Questions

- What spectrogram parameters work best for the species in this region? (FFT size, frequency range, color map)
- Should we support zooming into the spectrogram? (Raven has zoom + scroll)
- Should playback be synced with a cursor line on the spectrogram?
- Pre-generate spectrograms during scan, or only on-demand?
- What's the maximum file duration we need to handle? (affects spectrogram image size)
