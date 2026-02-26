# Grabaciones UX Improvements

**Date:** 2026-02-25
**Status:** Brainstormed

## What We're Building

A major UX overhaul of the Grabaciones (passive audio recordings) module to handle ~5,000 files per deployment, provide a better audio playback experience, and align with established camera trap UI patterns.

## Key Decisions

### Deployments List Page (`/audio`)

- **Mirror camera trap deployments table** — use TanStack React Table with sorting, filtering by project, pagination, and expandable rows
- **Expandable rows** show metadata: lat/lng, dates, file count, Drive folder link — same accordion pattern as camera trap (one row expanded at a time)
- **Deprioritize file sizes** — don't show total size in stats cards or per-row. Focus on file counts
- **Keep "Escanear Todo"** button for bulk scanning (already implemented)
- **Columns:** Instalacion, Proyecto, Sitio, Estado (scan status), Archivos (count), Fechas, expand chevron
- **Stats cards:** Total instalaciones, total archivos (no size card)

### Audio Files Detail Page (`/audio/[id]`)

- **Group files by date** — parse timestamp from filename (`SERIAL_YYYYMMDD_HHMMSS.wav`), group into collapsible date sections (e.g., "19 enero 2026 — 288 grabaciones"). Click to expand/collapse
- **Remove format column** — all files are .wav, not useful
- **Remove file size column** — deprioritized per user preference
- **Simplified file row:** Filename, recording time (HH:mm:ss), play button, download button
- **Sticky bottom audio player** — fixed bar at page bottom (Spotify-style). Shows: filename, play/pause, progress/seekbar with buffering indication, current time/duration, download button, close button
- **Spectrogram in player bar** — client-side Web Audio API renders a compact frequency visualization alongside the progress bar. Shows as audio plays/loads

### Audio Streaming

- **Range requests already supported** — browser `<audio>` can seek natively. Current `preload="none"` is fine; browser handles buffering
- **Buffering feedback** — the native `<audio>` progress bar shows buffered ranges. The sticky player should surface this visually (e.g., lighter fill for buffered portion vs played portion)

### Spectrogram

- **Client-side Web Audio API** — browser decodes WAV, generates spectrogram on `<canvas>`
- **Compact visualization** in the sticky bottom player bar
- **No server-side processing needed** — WAV files are already uncompressed PCM, easy for Web Audio API to decode
- **Tradeoff:** Needs full file downloaded before spectrogram is complete, but can progressively render as audio buffers

## Open Questions

- Should date sections default to collapsed or expanded? (With 5k files across ~30 days, collapsed makes sense)
- Do we want autoplay-next (play the next recording when current one finishes)?
- Spectrogram color scheme — grayscale, viridis, or custom?

## What We're NOT Building (Yet)

- BirdNET integration / species detection
- Annotation / tagging of audio clips
- Server-side spectrogram pre-rendering
- Batch download of audio files
