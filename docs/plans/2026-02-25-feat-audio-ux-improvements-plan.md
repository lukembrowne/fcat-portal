---
title: "feat: Audio UX Improvements"
type: feat
date: 2026-02-25
---

# Audio (Grabaciones) UX Improvements

## Overview

Major UX overhaul of the Grabaciones module to handle ~5,000 files per deployment. Mirrors established camera trap table patterns (TanStack React Table, expandable rows, sorting/filtering/pagination) and adds a sticky bottom audio player with client-side spectrogram visualization.

**Brainstorm:** `docs/brainstorms/2026-02-25-audio-ux-improvements-brainstorm.md`

## Key Design Decisions

- **Player is page-scoped** — lives inside `/audio/[id]` only, not in root layout. YAGNI: cross-page persistence adds architectural complexity (React Context, root layout state) for minimal benefit at this stage
- **5,000 files loaded at once** — all files fetched server-side, grouped by date on client. Date sections default collapsed, most recent expanded. No virtualization for now (collapsed sections render only headers, not rows)
- **Spectrogram uses real-time AnalyserNode** — FFT data captured during playback, rendered on canvas. Simpler than full-file decode, no memory spike, works progressively as audio plays. Full-file spectrogram can come later with BirdNET integration
- **Estado column is derived** — computed client-side from `audioFileCount` and `lastScanned` (no new DB field)
- **Non-parseable filenames** grouped under "Sin fecha" section

## Implementation Phases

### Phase 1: Deployments Table Rewrite

Replace the simple table in `audio-deployments-shell.tsx` with a TanStack React Table matching the camera trap pattern.

**Files to modify:**

- [x] `src/app/audio/page.tsx` — add `distinctProjects` fetch (for filter dropdown), pass to client
- [x] `src/app/audio/audio-deployments-shell.tsx` — full rewrite:
  - TanStack React Table with: `getCoreRowModel`, `getSortedRowModel`, `getFilteredRowModel`, `getPaginationRowModel`, `getExpandedRowModel`
  - Columns: Instalacion (sortable), Proyecto (sortable), Sitio (sortable), Estado (badge), Archivos (count, right-aligned), Fechas (date range), expand chevron
  - Toolbar: search input + project dropdown filter + "Escanear Todo" button (editor-only)
  - Pagination: 25/page with first/prev/next/last buttons
  - Accordion expansion: custom `handleExpandedChange` (one row at a time), collapse on page change
  - Remove stats cards (Instalaciones count, Archivos count, Tamano Total)

- [x] Create `src/app/audio/audio-expanded-row.tsx` — expanded row content:
  - Two-column grid (metadata left, actions right)
  - Left: metadata grid — Proyecto, Sitio, Lat, Lng, Fecha inicio, Fecha fin, Archivos en Drive, Archivos escaneados
  - Right: "Ver archivos" link to `/audio/[id]`, Drive folder link (editor-only), "Escanear" button (editor-only)
  - `onClick={(e) => e.stopPropagation()}` to prevent row collapse

**Estado badge values (derived):**

| Condition | Label | Variant |
|---|---|---|
| `lastScanned === null` | Sin escanear | `outline` |
| `audioFileCount > 0` | Escaneado | `secondary` |
| `lastScanned !== null && audioFileCount === 0` | Vacio | `destructive` |

**Pattern reference:** `src/app/camera-trap/deployments-table.tsx` (columns, toolbar, pagination, accordion), `src/app/camera-trap/deployment-expanded-row.tsx` (expanded row layout)

### Phase 2: Audio Files Page — Date Grouping

Replace the flat files table with collapsible date-grouped sections.

**Files to modify:**

- [x] `src/app/audio/[id]/audio-files-shell.tsx` — full rewrite:
  - Parse timestamp from each filename using `parseRecordingTimestamp()` (already exists)
  - Group files by date: `Map<string, AudioFileRow[]>` where key is `YYYY-MM-DD`
  - Files with unparseable timestamps go in a "Sin fecha" group (sorted last)
  - Render each date group as a collapsible section:
    - Header: localized date (`new Date(dateStr).toLocaleDateString("es-EC", { day: "numeric", month: "long", year: "numeric" })`) + file count ("288 grabaciones")
    - Chevron icon rotates on expand/collapse
    - Click header to toggle
  - Default state: all collapsed except the most recent date
  - Within each section, simplified rows: recording time (`HH:mm:ss`), play button (if playable), download button
  - Remove format column, remove file size column
  - Footer: total file count only (no size)

- [x] `src/app/audio/[id]/page.tsx` — no changes expected (data loading stays the same)

**Gotcha (from learnings):** Apply `min-w-0` to flex children in the layout chain. Test with sidebar open (narrowest content width). Apply `overflow-x: hidden` explicitly.

### Phase 3: Sticky Bottom Audio Player

Replace the inline `<audio>` element with a fixed bottom bar.

**Files to modify:**

- [x] `src/app/audio/[id]/audio-player.tsx` — full rewrite as sticky player:
  - `position: fixed; bottom: 0; left: 0; right: 0` with appropriate z-index
  - Layout: `[spectrogram canvas] [file info] [play/pause] [progress bar] [time] [download] [close]`
  - Custom progress bar (not native `<audio controls>`):
    - Hidden `<audio>` element as the actual media source
    - Track `currentTime`, `duration` via `timeupdate` event
    - Track `buffered` ranges via `progress` event
    - Visual: gray track, lighter fill for buffered range, accent fill for played range, draggable thumb
    - Click-to-seek: `audio.currentTime = (clickX / barWidth) * audio.duration`
    - Drag-to-seek: mousedown/mousemove/mouseup on progress bar
  - Time display: `mm:ss / mm:ss` format
  - Play/pause toggle button
  - Download button (link to `/api/audio/stream?fileId=...&download=true`)
  - Close button (stops audio, hides player)
  - Keyboard: Space = play/pause, ArrowLeft/Right = seek 5s

- [x] `src/app/audio/[id]/audio-files-shell.tsx` — add bottom padding when player is visible:
  - Track `activeFileId` state
  - When player visible, add `pb-20` (or dynamic padding matching player height) to the main container
  - Clicking play on a different file switches the player source (does not close/reopen)
  - Clicking play on the currently-playing file pauses it (Spotify behavior)

**Overlap with FloatingJobProgress:** The `FloatingJobProgress` component at `src/components/floating-job-progress.tsx` uses `fixed bottom-4 right-4 z-50`. The audio player will also be `z-50` at `bottom-0`. Solution: the audio player should use `z-40` so FloatingJobProgress layers on top. The progress widget is small enough to not occlude the player controls.

### Phase 4: Client-Side Spectrogram

Add a real-time frequency visualization in the sticky player bar using Web Audio API.

**Files to create:**

- [x] Create `src/app/audio/[id]/spectrogram.tsx` — Client Component:
  - Create `AudioContext` and `AnalyserNode` on first play
  - Connect: `<audio>` element → `MediaElementAudioSourceNode` → `AnalyserNode` → `audioContext.destination`
  - `AnalyserNode` config: `fftSize: 2048`, `smoothingTimeConstant: 0.8`
  - Canvas element (compact, ~60px height, full width of its container in the player bar)
  - `requestAnimationFrame` loop:
    - Get frequency data via `analyser.getByteFrequencyData()`
    - Draw vertical frequency bars or rolling spectrogram columns (grayscale)
    - Time axis scrolls left as audio plays (waterfall style)
  - Props: `audioRef: RefObject<HTMLAudioElement>`, `isPlaying: boolean`
  - Cleanup: disconnect nodes and close AudioContext on unmount

- [x] `src/app/audio/[id]/audio-player.tsx` — integrate spectrogram:
  - Pass `audioRef` and `isPlaying` to `<Spectrogram>` component
  - Position canvas in the player bar layout (left side, before file info)

**Spectrogram params:**
- FFT size: 2048 (1024 frequency bins)
- Color map: grayscale (0 = black, 255 = white)
- Display: rolling waterfall (new columns appear on right, scroll left)
- Frequency range: full (0 to Nyquist, typically 22.05kHz for 44.1kHz audio)
- Clickable: yes — clicking on the spectrogram seeks to that time position

**Note:** `MediaElementAudioSourceNode` can only be created once per `<audio>` element. Store the source node in a ref and reuse it when switching files. When the audio `src` changes, the existing connection stays valid.

### Phase 5: Polish and Edge Cases

- [x] Handle non-parseable filenames: files without `_YYYYMMDD_HHMMSS` pattern go in "Sin fecha" section, showing full filename instead of just time
- [x] Handle empty deployments (0 scanned files): show empty state with scan prompt for editors, "No hay archivos" for viewers
- [x] Handle `.wac`/`.w4v` files: hide play button, show download only, no "No compatible" badge needed (just absence of play button)
- [x] Test with sidebar open (narrowest viewport) per learnings about `min-w-0` flex issues
- [x] Verify `revalidatePath` after scan updates both the deployments list and the files page

## Acceptance Criteria

### Functional

- [x] `/audio/` shows TanStack table with sorting, project filter, pagination (25/page)
- [x] Rows expand accordion-style showing deployment metadata (lat/lng, dates, file count)
- [x] Expanded row has "Ver archivos" link and editor-only scan button
- [x] `/audio/[id]` groups files by date with collapsible sections
- [x] Date sections default collapsed, most recent expanded
- [x] Sticky bottom player appears on file play, persists while scrolling
- [x] Custom progress bar shows played + buffered ranges, supports click/drag seeking
- [x] Spectrogram renders real-time frequency data in the player bar
- [x] Keyboard shortcuts work: Space (play/pause), ArrowLeft/Right (seek 5s)

### Non-Functional

- [x] 5,000 files render without visible lag (collapsed sections = minimal DOM)
- [x] No layout regressions with sidebar open/closed
- [x] No z-index conflicts with FloatingJobProgress
- [x] Build passes (`npm run build`)

## References

- Camera trap table: `src/app/camera-trap/deployments-table.tsx`
- Camera trap expanded row: `src/app/camera-trap/deployment-expanded-row.tsx`
- Current audio files shell: `src/app/audio/[id]/audio-files-shell.tsx`
- Current audio player: `src/app/audio/[id]/audio-player.tsx`
- Streaming API: `src/app/api/audio/stream/route.ts`
- FloatingJobProgress (z-index reference): `src/components/floating-job-progress.tsx`
- Flex `min-w-0` learning: `docs/solutions/ui-bugs/biochoco-overview-horizontal-scroll-map-overlap.md`
