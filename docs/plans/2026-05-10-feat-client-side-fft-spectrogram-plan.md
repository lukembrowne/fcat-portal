---
title: Client-side FFT spectrogram for audio annotation
type: feat
date: 2026-05-10
brainstorm: docs/brainstorms/2026-05-10-audio-spectrogram-redesign-brainstorm.md
branch: feat/birdnet-audio-analysis
---

# Client-side FFT spectrogram for audio annotation

## Overview

Replace wavesurfer.js's `SpectrogramPlugin` on the audio annotation page (`src/app/audio/[id]/annotate/[fileId]/`) with a custom client-side FFT + stacked-canvas renderer. The new component owns its own y-axis, supports time+frequency bounding boxes with resize handles, and exposes live FFT/gain/colormap controls. The existing branch (`feat/birdnet-audio-analysis`) is already mid-migration and currently has a broken import — this plan completes that migration and extends it with the spectrolipi-inspired UX.

## Problem Statement / Motivation

The current wavesurfer-based renderer has three structural problems that no incremental fix can solve:

1. **Y-axis is wavesurfer-internal**: `SpectrogramPlugin.frequencyMax` only relabels — it does not crop the rendered band. The branch works around this by **resampling the audio to 24 kHz** in the browser (`src/lib/audio-resample.ts`) so that Nyquist becomes the visual ceiling. That's a 500 ms–1 s extra decode pass per file plus a wavesurfer-shaped y-axis users can't customize.
2. **Boxes lose frequency information**: `RegionsPlugin` only encodes time. Drag-to-create returns `start`/`end`, so `wavesurfer-spectrogram.tsx:189-194` hardcodes `minFreq: 0, maxFreq: 15000`. The DB schema (`audio_detections.minFreq` / `maxFreq` are non-null) is freq-aware; the UI is throwing away the data. BirdNET also writes 0/15000 (`birdnet-runner.ts:219-220`) because the Python output doesn't carry bands today.
3. **No user-facing FFT/gain/colormap controls**: wavesurfer fixes these at init time. Annotators can't adapt to noisy vs quiet recordings.

Plus, the WIP branch ships a broken state: `annotation-client.tsx:46` imports `./spectrogram-overlay` (deleted in this branch), so the page won't compile until either the wavesurfer component is wired up or this redesign lands.

The brainstorm settled on **client-side FFT + stacked canvases**, modelled on spectrolipi but using the project's existing `bbox-overlay.tsx` SVG overlay pattern from camera-trap.

## Proposed Solution

Build a new `<FftSpectrogram>` React component that:

1. Decodes the streamed audio via `AudioContext.decodeAudioData` at native sample rate (no resample).
2. Computes FFT magnitudes once per file using `fft.js` on the main thread (~60 ms for typical 60 s files).
3. Renders to a stack of canvases:
   - `data-layer="spec"` — magnitude → colormap LUT → ImageData → `drawImage` from offscreen
   - `data-layer="freq-axis"` — left-side Hz/kHz ticks, redraws on `displayMaxHz` change
   - `data-layer="time-axis"` — bottom seconds ticks
   - SVG overlay for boxes (reuses bbox-overlay's hit-testing pattern) + playhead
4. Exposes the same `SpectrogramMethods` imperative ref shape `annotation-client.tsx` already uses, so the parent change is a one-line import swap.
5. Provides a controls toolbar with: y-max preset (3/6/9/12 kHz/Nyquist), gain dB slider, dynamic-range slider, FFT size selector, colormap selector. Changes that don't invalidate the FFT (gain, colormap, dynamic range, y-max) re-render in <10 ms by remapping the cached magnitudes.

DB / server actions are **untouched**: `createAudioDetection` already accepts `{ startTime, endTime, minFreq, maxFreq }` (`src/app/audio/annotation-actions.ts:76-136`).

## Technical Considerations

### Architecture

**Layer model**:

```
<FftSpectrogram>
├── <SpectrogramControls>                         ← toolbar (toolbar canvas-state owns yMax, fftSize, gainDB, rangeDB, colormap)
├── <div class="canvas-stack">
│   ├── <canvas data-layer="spec">                ← magnitude pixels, drawImage from offscreen
│   ├── <canvas data-layer="freq-axis">           ← left 70 px gutter
│   ├── <canvas data-layer="time-axis">           ← bottom 24 px gutter
│   ├── <svg data-layer="boxes">                  ← bbox-overlay-style hit-testing
│   └── <div data-layer="playhead">               ← absolutely-positioned 2-px line, transform: translateX
└── <audio> (hidden)                              ← native playback element
```

**Pure modules** (no React, easy to test):

- `src/lib/audio-fft.ts` — `decodeAudio(url) → Float32Array & sampleRate`; `computeMagnitudes({samples, fftSize, hopSize, windowFn}) → {magnitudes: Float32Array, numFrames, binCount}` where `magnitudes` is a flat `Float32Array(numFrames * binCount)` row-major (faster than per-frame allocs).
- `src/lib/spectrogram-colormaps.ts` — `Uint8ClampedArray` LUTs (256×3) for viridis, magma, inferno, turbo. Adapted from Mikhailov's Turbo gist + matplotlib viridis/magma/inferno tables. Drop the wavesurfer `roseus` default.
- `src/lib/spectrogram-render.ts` — `renderImageData({magnitudes, numFrames, binCount, displayMaxBin, gainDB, rangeDB, colormap}) → ImageData(numFrames, displayMaxBin)`. Pure; called from React on knob change.

### Coordinate math (single source of truth)

```
binFromHz(hz)        = Math.round(hz * fftSize / sampleRate)
hzFromBin(bin)       = bin * sampleRate / fftSize
frameFromTime(t)     = Math.floor(t * sampleRate / hopSize)
timeFromFrame(frame) = frame * hopSize / sampleRate
canvasYFromHz(hz)    = canvasH * (1 - hz / displayMaxHz)
canvasXFromTime(t)   = canvasW * (t / duration)
hzFromCanvasY(y)     = displayMaxHz * (1 - y / canvasH)
timeFromCanvasX(x)   = duration * (x / canvasW)
```

### State machine for re-renders

| Knob changed | Action |
|---|---|
| Audio file (URL) | refetch → decode → FFT → render |
| FFT size or hop | recompute FFT → render (the only "expensive" change, ~60 ms) |
| Gain / dynamic range / colormap | render only (~10 ms; keep cached `magnitudes`) |
| `displayMaxHz` | render only — clip rows to `displayMaxBin` |
| Window resize | re-blit existing offscreen → drawImage scaled (no recompute) |
| Detections list | repaint SVG overlay only |
| Playhead | rAF, transform-only on the playhead div |

### DPR handling

Single helper sets all canvases:

```ts
function sizeCanvas(canvas: HTMLCanvasElement, cssW: number, cssH: number) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.getContext("2d")!.setTransform(dpr, 0, 0, dpr, 0, 0);
}
```

Resize observer on the container re-runs sizing for all five layers.

### Box drawing & editing (port from `bbox-overlay.tsx`)

- SVG `viewBox="0 0 1 1"` with normalized `(time/duration, 1 - freq/displayMaxHz)` coords.
- Drag empty area: live preview rect, on `pointerup` call `onDrawComplete({startTime, endTime, minFreq, maxFreq})`.
- Click body: select. Selected box gets 8 handles (corners + edge midpoints). Drag handle: resize. Drag body: move.
- `MIN_BOX_PX=10` minimum size (in CSS px, not normalized) to avoid 0-area accidents.
- Pointer capture for stable drag.
- Constants reused from `bbox-overlay.tsx:33-45` color palette — extract to `src/lib/species-color.ts` to stop the third copy (current copies in `bbox-overlay.tsx` and `wavesurfer-spectrogram.tsx`).

### Performance budget (per [research](https://toughengineer.github.io/demo/dsp/fft-perf/))

For 60 s mono @ 24 kHz, FFT 1024, hop 512:
- 2,812 frames × ~10 µs = ~28 ms FFT
- 2,812 × 512 × 4 B = ~5.6 MB cached magnitudes
- LUT remap: ~10 ms

For 5 min @ 48 kHz, FFT 1024, hop 512:
- ~28,125 frames × ~10 µs = ~280 ms
- ~58 MB magnitudes — still fine
- Decision: **no Web Worker for v1**. Show a "Calculando espectrograma…" spinner; defer worker until users complain or files routinely exceed 10 min.

### Browser quirks

- `decodeAudioData` is unreliable on `OfflineAudioContext` for analysis ([WebAudio #303](https://github.com/WebAudio/web-audio-api/issues/303)) — use a regular `AudioContext` and immediately suspend it after decode.
- Drive stream may omit `Content-Length`; the existing `/api/audio/stream` already falls back to `audioFile.fileSize` ([learning](docs/solutions/runtime-errors/spectrogram-process-explosion-AudioCache-20260226.md)).
- Wrap `decodeAudioData` in try/catch — show "Audio no decodificable" with retry button.

### Concurrency

The current branch had a **process-explosion incident** with the previous server-side spectrogram poll loop ([solution doc](docs/solutions/runtime-errors/spectrogram-process-explosion-AudioCache-20260226.md)). Client-side FFT eliminates the loop entirely — no inflight dedup needed, no server processes spawned.

### Spanish UI strings (per CLAUDE.md)

```
"Calculando espectrograma…"
"Audio no se pudo decodificar. Intenta de nuevo o salta a otro archivo."
"Reintentar"
"Frecuencia máxima"  (label for displayMaxHz)
"Ganancia"           (gain)
"Rango dinámico"     (rangeDB)
"Tamaño FFT"         (fftSize)
"Mapa de color"      (colormap)
```

### Permissions

No server-action signature changes; existing `requirePermission("grabaciones", "editor")` on `createAudioDetection` continues to gate freq-aware writes.

## Acceptance Criteria

### Functional — must work end to end
- [ ] Page `/audio/:id/annotate/:fileId` loads without import errors and renders a spectrogram for any playable audio file
- [ ] Frequency axis labels are crisp on retina screens, formatted as `Hz` < 1 kHz and `kHz` ≥ 1 kHz, redrawn independently of the spectrogram
- [ ] Y-max preset dropdown clamps the visible frequency band instantly without re-FFT (verified by no spinner on change)
- [ ] FFT size selector (512 / 1024 / 2048) triggers spinner + recompute and finishes in <500 ms for typical files
- [ ] Gain dB and dynamic-range sliders re-render in <50 ms; LUT swap updates the spectrogram without spinner
- [ ] Colormap selector switches LUT, applies immediately
- [ ] Drag-to-create on the spectrogram captures `{startTime, endTime, minFreq, maxFreq}` with all four values from the user's drag (no hardcoded 0/15000)
- [ ] Clicking an existing box selects it; selected box shows 8 resize handles for editors
- [ ] Drag a body to move; drag a handle to resize; both clamped to `[0, duration]` and `[0, sampleRate/2]`
- [ ] Click outside any box and on the spectrogram body deselects
- [ ] BirdNET-generated boxes (legacy 0/15000) render visibly distinct (lower opacity / dashed border) so annotators know they're imprecise; can still be selected and refined
- [ ] Playhead tracks `<audio>.currentTime` at 60 fps; click on time axis seeks
- [ ] Existing keyboard shortcuts continue to work (Space, Q/E, [/], 1-9, etc.)
- [ ] New shortcuts: `f` cycles y-max preset, `m` cycles colormap, `+`/`-` adjust gain by 5 dB
- [ ] No 500 errors when audio fails to decode — user-facing Spanish error with retry

### Non-functional
- [ ] No regression in time-to-first-render vs. wavesurfer for 60 s files (target: ≤1.5 s after audio fetch completes)
- [ ] Memory: cached magnitudes < 100 MB for any single file (gates a future warning if exceeded)
- [ ] No console errors or warnings on Chrome / Firefox / Safari
- [ ] No deprecation of the existing `audio_files.spectrogram_path` schema column (leave for future server-pregen optionality)

### Quality gates
- [ ] Unit tests for `audio-fft.ts`: deterministic 440 Hz sine wave at 24 kHz produces magnitude peak in expected bin (allow ±1 bin tolerance)
- [ ] Unit tests for `spectrogram-render.ts`: monotonic magnitudes → monotonic ImageData luminance per row
- [ ] Manual smoke test: full annotation flow on a real 30 s recording from FCAT (draw box, assign species, verify, advance to next file)
- [ ] `npm run lint` passes
- [ ] `npm run build` succeeds
- [ ] `wavesurfer.js` removed from `package.json` (no other consumers — confirm via grep)

## Implementation Phases

### Phase 1 — Foundation: pure modules (no React)

**Goal**: testable FFT + render utilities. No UI changes yet.

#### Tasks
- [ ] Add `fft.js` to `package.json` (`npm install fft.js`); declare local types in `src/types/fft-js.d.ts` (the package ships no `.d.ts`).
- [ ] **`src/lib/audio-fft.ts`**
  - `export async function decodeAudio(url: string): Promise<{samples: Float32Array; sampleRate: number; duration: number}>` — fetch → arrayBuffer → `decodeAudioData` → mono mix-down via average of channels → close `AudioContext`.
  - `export type Magnitudes = { magnitudes: Float32Array; numFrames: number; binCount: number; sampleRate: number; fftSize: number; hopSize: number };`
  - `export function computeMagnitudes({samples, sampleRate, fftSize, hopSize}: ComputeArgs): Magnitudes` — Hann window, fft.js `realTransform`, magnitude = `sqrt(re² + im²)`, store `dB = 20 * log10(mag + 1e-12)`. Return flat row-major Float32Array.
  - Keep deterministic and side-effect free for unit tests.
- [ ] **`src/lib/spectrogram-colormaps.ts`**
  - Export const `COLORMAPS: Record<"viridis" | "magma" | "inferno" | "turbo", Uint8ClampedArray>` (each 256×3 RGB).
  - Source LUT values from Mikhailov turbo gist + matplotlib viridis/magma/inferno arrays (~3 KB total source code).
- [ ] **`src/lib/spectrogram-render.ts`**
  - `renderImageData({magnitudes, numFrames, binCount, displayMaxBin, gainDB, rangeDB, colormap}) → ImageData(numFrames × displayMaxBin)`.
  - Pixel mapping: `t = (db + gainDB - (-rangeDB)) / rangeDB` clipped to [0,1]; index LUT at `Math.round(t * 255) * 3`. Y-flip so low freq is at bottom.
- [ ] **`src/lib/species-color.ts`** — extract the duplicated palette + `getSpeciesColor(name)` from `bbox-overlay.tsx:33-45` and `wavesurfer-spectrogram.tsx:43-56`. Update both call sites to import from here (touch-and-go cleanup; no behavior change).

#### Concrete details for Phase 1

**Function signatures** (types only; no implementation):

```ts
// src/lib/audio-fft.ts
export type DecodedAudio = { samples: Float32Array; sampleRate: number; duration: number };
export type ComputeArgs = { samples: Float32Array; sampleRate: number; fftSize: number; hopSize: number };
export type Magnitudes = {
  magnitudes: Float32Array;          // row-major: row = frame, col = bin; length = numFrames * binCount
  numFrames: number;
  binCount: number;                  // fftSize / 2 + 1 (DC..Nyquist inclusive)
  sampleRate: number;
  fftSize: number;
  hopSize: number;
};
export function decodeAudio(url: string): Promise<DecodedAudio>;
export function computeMagnitudes(args: ComputeArgs): Magnitudes;

// src/lib/spectrogram-colormaps.ts
export type ColormapName = "viridis" | "magma" | "inferno" | "turbo";
export const COLORMAPS: Record<ColormapName, Uint8ClampedArray>; // each 768 = 256*3 RGB

// src/lib/spectrogram-render.ts
export type RenderArgs = {
  magnitudes: Float32Array; numFrames: number; binCount: number;
  displayMaxBin: number; gainDB: number; rangeDB: number; lut: Uint8ClampedArray;
};
export function renderImageData(args: RenderArgs): ImageData; // width=numFrames, height=displayMaxBin
```

**Memory layout — row-major (frame-major)**: `magnitudes[frame * binCount + bin]`. Row-major because the render hot loop iterates `for (x=frame) for (y=bin)` writing one image column per frame; column-major would force a stride-`numFrames` jump per pixel, defeating the L1 cache. The compute loop is also row-major (one frame at a time → write `binCount` contiguous values).

**Numerical edge cases**:
- Silence / all-zero frames produce `log10(0) = -∞`. Compute `dB = 20 * Math.log10(mag + 1e-12)` then clamp `dB = Math.max(dB, -120)` before storing. Storing dB (not raw magnitude) lets the render path skip log entirely on knob changes.
- DC bin (index 0) is included but rendered; users can ignore visually. Do not zero it — it is information.
- Nyquist bin is index `fftSize/2`; `binCount = fftSize/2 + 1`. Include it.
- `hopSize` must satisfy `0 < hopSize <= fftSize`. Validate at function entry; throw on violation. `numFrames = Math.floor((samples.length - fftSize) / hopSize) + 1` (frames that fit fully); zero-pad the tail only if `numFrames < 1`.
- `fftSize` must be a power of two and ≥ 2 (fft.js requirement); validate.

**Hann window**: precompute once per `(fftSize)` and cache in a module-level `Map<number, Float32Array>`. A 2048-sample Hann is 8 KB; recomputing per frame for a 5-min file is ~28k allocations. Tradeoff: a 4-entry Map vs. throwaway garbage — precompute wins decisively.

**fft.js API (verified against README)**: `new FFT(N)`; `out = fft.createComplexArray()` has length `2*N` (interleaved Re/Im pairs). `fft.realTransform(out, realInput)` fills only the **left half** of `out` (entries `0..N-1`, i.e. bins 0..N/2 as interleaved Re/Im) — that is exactly the non-redundant DC..Nyquist range we need; do **not** call `completeSpectrum`. README does not state forward normalization; fft.js returns unnormalized output (consumer divides by `N` or by window-sum). For magnitude-spectrogram display we only need a consistent scale, so we skip the `1/N` divisor and let the user-controllable `gainDB` absorb absolute level. **One-line test to pin this down**: feed a unit-amplitude 1 kHz sine at 24 kHz into fftSize 1024 with a Hann window; observe peak-bin magnitude `M`, confirm `20*log10(M)` lands within ±1 dB of the value matching `0.5 * sum(window)` (Hann sum = `N/2`).

**Mono mix-down**: simple arithmetic mean of channels: `mono[i] = (L[i] + R[i]) / 2`. We are not preserving stereo phase, and equal-weight averaging matches what humans perceive when both speakers play together. Skip ITU-R BS.775 weighting — overkill for spectrogram visualization where dynamic range is already user-controlled.

**Colormap LUT format**: inline `Uint8ClampedArray` literals exported from `spectrogram-colormaps.ts`. Justification: no `fetch`, no JSON parse cost on first render, tree-shakable (unused colormaps drop out), and the four LUTs total ~3 KB source — smaller than a network round-trip's TLS overhead.

**Render hot loop** (pseudocode — DO NOT include this verbatim in the source as a comment):

```
const inv = 1 / rangeDB;             // precompute
const data = imageData.data;          // Uint8ClampedArray, length = 4 * W * H
for (let x = 0; x < numFrames; x++) {
  const rowBase = x * binCount;
  for (let y = 0; y < displayMaxBin; y++) {
    const db = magnitudes[rowBase + (displayMaxBin - 1 - y)] + gainDB;  // y-flip: low freq at bottom
    let t = (db + rangeDB) * inv;     // map [-rangeDB, 0] → [0, 1]
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const lutIdx = (t * 255) | 0;     // bitwise-or-zero faster than Math.round here
    const px = (y * numFrames + x) * 4;
    const li = lutIdx * 3;
    data[px]     = lut[li];
    data[px + 1] = lut[li + 1];
    data[px + 2] = lut[li + 2];
    data[px + 3] = 255;
  }
}
```

Hot-path rules: no allocations inside the loop, precompute `1/rangeDB` once, prefer `| 0` over `Math.round` for non-negative clamped values, keep `lut`/`magnitudes`/`data` as locals so V8 can keep them register-resident. Skip `Math.imul` — there is no measurable win on this index arithmetic. The `Math.log10 → Math.log * 0.4343` swap is moot because dB is computed once during `computeMagnitudes`, never in the render loop.

**Test fixtures**: synthesize at test time via a helper, do **not** commit binary blobs.
- Add `tests/helpers/synth-sine.ts` exporting `synthSineSamples(freqHz, durationSec, sampleRate): Float32Array` (no WAV header — `computeMagnitudes` consumes raw `Float32Array`).
- For the `decodeAudio` integration test, generate a short WAV in-memory with a tiny WAV-header writer in the same helper file (~30 lines), wrap in `Blob` + `URL.createObjectURL`. No fixture files in `tests/fixtures/`.
- Justification per CLAUDE.md: no unrelated abstractions, no committed binaries that bloat the repo and dodge code review.

**Decisions to confirm**:
- fft.js README does not specify forward-transform normalization. The plan above assumes unnormalized output and absorbs scale into `gainDB`. Verify with the one-line sine test above before merging Phase 1; if scale is wildly off expectations, divide by `windowSum` (not `N`) inside `computeMagnitudes`.
- README phrasing "fills the left half ... with the real part" is imprecise — left half is interleaved Re/Im for bins 0..N/2. The sine test will also verify this (peak should appear at the expected bin index, not at twice that index).
- Confirm `OfflineAudioContext` is genuinely unsuitable here vs. a plain `AudioContext` immediately suspended — the plan currently assumes plain `AudioContext` per WebAudio issue #303.

#### Tests (Vitest unit)
- `tests/unit/audio-fft.test.ts` — synthesized 440 Hz sine at 24 kHz, fftSize 1024, expect peak bin ≈ 19 (`440 * 1024 / 24000 = 18.77`).
- `tests/unit/spectrogram-render.test.ts` — rising-magnitude column produces rising luminance.

#### Success criteria
Phase 1 ships behind no flag — pure modules, nothing wired in. `npm run test:run` green.

---

### Phase 2 — `FftSpectrogram` component

**Goal**: a drop-in replacement for `<WavesurferSpectrogram>` with the same imperative API, no controls toolbar yet (defaults hardcoded).

#### Tasks
- [ ] **`src/app/audio/[id]/annotate/[fileId]/fft-spectrogram.tsx`**
  - Props mirror `WavesurferSpectrogramProps` exactly (audioUrl, boxes, selectedBoxId, editable, onBoxClick, onDrawComplete, onReady, onTimeUpdate, onPlayPause).
  - Plus new props: `displayMaxHz`, `gainDB`, `rangeDB`, `fftSize`, `colormap` (controlled by parent for now; reasonable defaults: 12000, 25, 70, 1024, "magma").
  - State: `loadStage = "idle" | "fetching" | "computing" | "ready" | "error"`, `audioBuffer`, `magnitudes`, `error`.
  - Effects:
    1. on `audioUrl` change → `decodeAudio(url)` → set `audioBuffer`, advance stage
    2. on `audioBuffer` or `fftSize` change → `computeMagnitudes` → set `magnitudes`
    3. on `magnitudes`, `gainDB`, `rangeDB`, `colormap`, `displayMaxHz` change → `renderImageData` → blit to spectrogram canvas
    4. ResizeObserver → re-blit existing offscreen scaled to new CSS dims
- [ ] **DPR sizing helper** — local `sizeCanvas` util, called for all 4 canvases on mount and resize.
- [ ] **5-canvas stack** as in the architecture diagram. Single absolutely-positioned wrapper; overlay layers `pointer-events: none` except the SVG.
- [ ] **Frequency axis** — draw on `data-layer="freq-axis"`, ticks at "nice" multiples of 1/2/5×10ⁿ Hz chosen for ~6 ticks; format `Hz`/`kHz` per spectrolipi.
- [ ] **Time axis** — pick interval from `[0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60]` to keep ~80 px spacing; format `s` < 60, `MM:SS` ≥ 60.
- [ ] **SVG box overlay** — port hit-testing, palette, label-flip from `bbox-overlay.tsx`. Coordinates normalized `[0,1]`. Selected box has 8 `<rect>` handles; cursor changes per handle (`ns-resize`, `ew-resize`, `nwse-resize`, etc.).
- [ ] **Drag-to-create** — only fires when drag starts on empty area, not on an existing box. `onDrawComplete({startTime, endTime, minFreq, maxFreq})` called once at `pointerup` if box ≥ MIN size.
- [ ] **Drag-to-move / drag-handle-to-resize** — only when `editable=true` and a box is selected. Emit `onBoxResized(boxId, newCoords)` callback (new optional prop) so the parent can persist.
- [ ] **Playhead** — `<div>` with `transform: translateX(...)`, updated in a rAF loop while `isPlaying`. Clicking the time-axis canvas calls `seek(timeFromCanvasX(x))`.
- [ ] **Native `<audio>`** — owned by this component; expose `play`/`pause`/etc. via `forwardRef` + `useImperativeHandle`. Same shape as `WavesurferMethods`; rename type to `SpectrogramMethods` (export both for one-cycle compatibility).
- [ ] **Loading & error states** — Spanish strings as listed in Technical Considerations.
- [ ] Legacy 0/15000 boxes: detect `minFreq === 0 && maxFreq === 15000` (or `>= sampleRate/2 - 1`) → render with dashed stroke + reduced fill opacity.

#### Box interaction model

Mirror `bbox-overlay.tsx` patterns so muscle memory transfers from camera-trap.

**1. Hit testing (pointerdown precedence)** — first match wins: handle (8 px hit-slop via invisible 24×24 sibling `<rect>`) → selected-body → unselected-body (select-only) → empty area (only when `editable && onDrawComplete`). Reuse `closest("[data-bbox]")` (`bbox-overlay.tsx:147`); tag handles with `data-handle="nw|n|ne|e|se|s|sw|w"`.

**2. Drag state machine** — `idle | drawing-new | moving | resizing`:
- `idle → drawing-new` on empty-area pointerdown.
- `idle → moving` on selected-body pointerdown past `DRAG_THRESHOLD=5px` (`bbox-overlay.tsx:53,174`); below threshold = click (toggle selection).
- `idle → resizing` on handle pointerdown (no threshold).
- `pointerup`: commit if `hasDragged && passes-min-size`, else discard; reset to `idle` (`bbox-overlay.tsx:192-219`).
- `pointercancel` / `Escape`: discard `dragOverride`, no callback, return to `idle`.

**3. Constraints during drag**:
- Clamp time to `[0, duration]`, freq to `[0, sampleRate/2]` — **not** `displayMaxHz` (that's a visual clip; a box drawn at 6 kHz zoom can legitimately reach 12 kHz when zoom changes).
- Reject at `pointerup` if width or height < 10 CSS px (reuse `MIN_BOX_PX`, `bbox-overlay.tsx:54,209-214`). Silent discard, no live feedback.
- No Shift-aspect-ratio in v1 — bird calls have no canonical ratio.

**4. Handle layout** (selected only): 8 `<rect>` 8×8 CSS px at `nw=(x,y)`, `n=(x+w/2,y)`, `ne=(x+w,y)`, `e=(x+w,y+h/2)`, `se=(x+w,y+h)`, `s=(x+w/2,y+h)`, `sw=(x,y+h)`, `w=(x,y+h/2)`. Render via `transform={\`translate(${nx*W - 4} ${ny*H - 4})\`}` so the px size stays constant. Cursors: `nw/se → nwse-resize`, `ne/sw → nesw-resize`, `n/s → ns-resize`, `e/w → ew-resize`.

**5. Selection visual states** (compose with the new `src/lib/species-color.ts`):
- Unselected: `strokeWidth=1.5`, `fillOpacity=0.15`.
- Hover (unselected): `strokeWidth=2`, cursor `pointer`.
- Selected: `strokeWidth=2.5`, `fillOpacity=0.30`, handles visible.
- Legacy 0/15000: `strokeDasharray="4 3"`, `opacity=0.6` — overrides the above so "imprecise" reads at a glance.

**6. Label placement**: copy `bbox-overlay.tsx:300-330` verbatim (auto-flip below when `py < 20`, shift text past number badge when flipped). Solid `fill={getSpeciesColor(...)}` at `fillOpacity=0.75` (0.9 highlighted) for contrast.

**7. Resize edge cases**: clamp to `MIN_BOX_PX`, do **not** flip. Left handle past right edge freezes at `right - MIN_BOX_PX`; same for top/bottom. Matches Cornell Raven.

**8. `onBoxResized` timing**: fire **once** at `pointerup`, never during `pointermove`. While dragging, hold a local `dragOverride: { boxId, startTime, endTime, minFreq, maxFreq } | null`; render reads `dragOverride ?? box`. Clear after parent's optimistic update lands.

**9. Optimistic update vs refresh**: emit `onBoxResized` → parent applies optimistic local state, awaits server action, then calls `router.refresh()` on success. Matches camera-trap; avoids the "box jumps back then forward" flash that refresh-only causes.

**10. Keyboard nudge (flag for Phase 4)**: arrow keys nudge by 1 frame (`hopSize/sampleRate` s) / 1 bin (`sampleRate/fftSize` Hz); Shift+Arrow = 10×. Add `onNudgeSelectedBox(dx, dy, multiplier)` to `useAudioAnnotationShortcuts`; do not bind in Phase 2.

**Cross-references from `bbox-overlay.tsx`**:
- `ResizeObserver` + `img.load` (`:100-128`) drives `imgSize` for px-threshold math; FFT version needs the same observer on the spec canvas wrapper or `MIN_BOX_PX` / `DRAG_THRESHOLD` cannot convert normalized → px on resize.
- `onResize` prop (`:27-29,108`) — expose equivalent so playhead and future hover-magnifier share one coordinate space.
- `onResizeRef` ref-mirror (`:95-98`) avoids stale closures; replicate for `onBoxResized`, `onDrawComplete`, `onBoxClick`.
- `setPointerCapture` on `e.target` (`:158`), not the SVG root — keep that so handle captures release cleanly when cursor leaves the handle.
- `toNormalized` (`:131-141`) clamps via `getBoundingClientRect`; FFT needs a 2-axis variant returning `(time, freq)` in domain units, not normalized.
- `SPECIES_COLORS` cache is module-level (`:32`); Phase 1's `species-color.ts` extraction must keep that, not move to React state.

**Open UX questions**:
- Click on selected box body: deselect, or require outside-click / Esc?
- When a legacy 0/15000 box is first resized, drop the dashed style immediately, or wait until species is assigned?
- Touch-laptop hit-slop: 8 px or 12 px? Defer until a real touch tester reports.

#### Tests
- Component snapshot test or RTL mount test — ensure it renders without crashing given a mock `audioUrl` returning short PCM data.
- A Playwright test is overkill for v1; rely on manual smoke + unit FFT correctness.

#### Success criteria
Phase 2 module compiles and exports `FftSpectrogram` + `SpectrogramMethods`. Not yet imported anywhere.

---

### Phase 3 — `SpectrogramControls` toolbar

**Goal**: live FFT/gain/colormap controls that change the parent's state, which propagates to `<FftSpectrogram>`.

#### Tasks
- [ ] **`src/app/audio/[id]/annotate/[fileId]/spectrogram-controls.tsx`**
  - Controlled component receiving + emitting `{displayMaxHz, gainDB, rangeDB, fftSize, colormap}`.
  - UI: thin toolbar above the spectrogram. Compact `<select>` and range `<input>` elements styled with the existing button/UI primitives.
  - Spanish labels (see Technical Considerations).
  - Y-max preset: `[3000, 6000, 9000, 12000, sampleRate/2]` → "3 kHz" / "6 kHz" / "9 kHz" / "12 kHz" / "Máx (Nyquist)".
  - FFT size: 512 / 1024 / 2048; explanation tooltip: "Resolución temporal vs frecuencia".
  - Persist user choices to `localStorage` keyed `audio.spectrogram.v1` so settings stick across files in a session.

#### Success criteria
Toolbar renders in isolation; values flow up to parent state.

---

### Phase 4 — Wire into `annotation-client.tsx`

**Goal**: end-to-end flow works in the browser. **This is the first commit that the page actually renders**, since the WIP branch's broken `./spectrogram-overlay` import goes away here.

#### Tasks
- [ ] **`src/app/audio/[id]/annotate/[fileId]/annotation-client.tsx`**
  - Remove broken `./spectrogram-overlay` import (line 46 in current file).
  - Remove the spectrogram polling effect (lines 181-225 in the file as I read it) and `setRetryCount`/`MAX_POLLS` state — no longer needed.
  - Remove the polling-related UI ("Generando espectrograma…", retry button) and `spectrogramStage`, `spectrogramFileSize` state. Replace with the loading/error states emitted by `<FftSpectrogram>` itself via new `onLoadStateChange` callback (or keep simple: render the component always; it shows its own loading state internally).
  - Remove the local `<audio ref={audioRef}>` and the `selectionEndRef` / playhead rAF — moved into `<FftSpectrogram>`.
  - Replace `<SpectrogramOverlay>` JSX with `<FftSpectrogram ref={spectrogramRef} ...>`.
  - Wire toolbar state: `useState({...defaults})` and pass into both `<SpectrogramControls>` and `<FftSpectrogram>`.
  - Replace `audioRef.current?.play()` etc. with `spectrogramRef.current?.play()`.
- [ ] **`src/hooks/use-audio-annotation-shortcuts.ts`**
  - Add `onCycleYMax`, `onCycleColormap`, `onAdjustGain(delta: number)` options.
  - Bind: `f` → `onCycleYMax`, `m` → `onCycleColormap`, `+`/`=` → `onAdjustGain(+5)`, `-` → `onAdjustGain(-5)`.
  - Update `AUDIO_SHORTCUTS` array with new entries (Spanish: "f: Cambiar frecuencia máx", "m: Cambiar mapa de color", "+/-: Ganancia ±5 dB").
  - Guard `+`/`-` against modifier keys to not steal browser zoom.
- [ ] Hook box-resize callback: `<FftSpectrogram onBoxResized={handleBoxResized}>` calls a new `updateAudioDetection(detectionId, {minFreq, maxFreq, startTime, endTime})` server action.
- [ ] **`src/app/audio/annotation-actions.ts`**
  - Add `export async function updateAudioDetection(detectionId, box)`. Pattern mirrors `createAudioDetection`: `requirePermission("grabaciones", "editor")` → resource-scoped check via the existing helper → validate `start<end && minFreq<maxFreq` → `db.update(audioDetections).set({...}).where(eq(audioDetections.id, detectionId))` → `revalidatePath`. Return `ActionResult<undefined>`.

#### Tests
- `tests/integration/audio-detection-update.test.ts` — call `updateAudioDetection` as editor, expect success; as viewer, expect redirect (per existing camera-trap test pattern).
- Manual smoke: full keyboard tour of new shortcuts.

#### Success criteria
Page loads end-to-end. Drawing a box and assigning a species persists with the user's actual freq bounds. All existing shortcuts still work.

---

### Phase 5 — Cleanup

**Goal**: remove the wavesurfer dependency once Phase 4 is verified working.

#### Tasks
- [ ] Delete `src/app/audio/[id]/annotate/[fileId]/wavesurfer-spectrogram.tsx`
- [ ] Delete `src/lib/audio-resample.ts` (no remaining callers — verify `grep -r resampleAudioToWavBlobUrl src/`)
- [ ] Remove `wavesurfer.js` from `package.json` (verify `grep -r 'wavesurfer' src/` is empty)
- [ ] `npm install` to update lockfile
- [ ] Run `npm run build` — should succeed and produce a smaller bundle
- [ ] If `audio-cache.ts` server-side LRU is no longer touched by the annotation flow but still used by `src/app/audio/actions.ts:579`, leave it. Note this in the PR description.

#### Success criteria
- No references to `wavesurfer` or `resampleAudioToWavBlobUrl` in source.
- Bundle size reduced (record before/after for PR description).

---

### Phase 6 — Polish & deferred niceties (optional, can ship later)

- [ ] Repeat-last-annotation hotkey (clone last drawn box dimensions; spectrolipi pattern)
- [ ] Hover magnifier lens
- [ ] BirdNET-output backfill: if Python BirdNET output gains freq-band fields, update `birdnet-runner.ts:219-220` to use them instead of 0/15000
- [ ] Web Worker for FFT once long-file complaints arrive
- [ ] Annotation grid below the spectrogram (Tabulator-style bulk editor)

These are tracked in the brainstorm doc and intentionally not blocking v1.

## Dependencies & Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Some Drive-streamed audio fails to `decodeAudioData` | Medium | Annotator can't see spectrogram | Try/catch + Spanish error UI + skip-to-next button. Server-side pre-flight could be added in Phase 6 if real failures emerge. |
| `fft.js` perf worse than benchmark on Firefox/Safari | Low | UI feels sluggish on slow browsers | Worst case (~9× slower per [WebFFT benchmarks](https://webfft.com/)) is still <500 ms for typical files. Defer worker until measured. |
| Long files (>10 min) blow memory budget | Low | Tab crashes for niche cases | Add a check: if `samples.length / sampleRate > 600`, render a warning + offer "abrir más corto" workflow (e.g., truncate via Range request). |
| 8-handle resize UX is finicky on touch devices | Low (FCAT staff use desktops) | Touch users frustrated | Defer touch-specific tuning; use `pointer-events` so basic touch works. |
| WIP branch's broken state means we can't preview the wavesurfer baseline anymore | High | Hard to A/B compare | Acceptable — the wavesurfer version is documented in this plan and the brainstorm; its limitations were structural anyway. |
| `fft.js` no TS types | Low | Minor friction | Add a 10-line `src/types/fft-js.d.ts` shim. |
| Cache key collisions if two FFT components mount simultaneously | None | n/a | Magnitudes are component-scoped; no global cache yet. |

### Dependencies
- `fft.js` (~5 KB minified) — added in Phase 1
- No DB migrations
- No env var changes
- No infra changes
- No deploy ordering concerns

## Success Metrics

- **Pipeline simplification**: `audio-resample.ts` deleted, no `/api/audio/spectrogram*` endpoints needed (already absent), one fewer external library
- **Y-axis pain resolved**: y-max changes feel instant (<50 ms perceived); axis labels readable at all zoom levels and DPRs
- **Freq-aware annotations**: 100% of newly drawn boxes carry annotator-specified `minFreq`/`maxFreq` (verified by querying `audio_detections` after a smoke test session)
- **No regressions**: existing keyboard shortcuts still work; verify-all-and-advance still navigates correctly; species sidebar + hotkeys 1-9/0 unchanged

## References & Research

### Internal — relevant files
- `src/app/audio/[id]/annotate/[fileId]/annotation-client.tsx` — broken `./spectrogram-overlay` import (line 46), polling loop to remove (181-225), local `<audio>` element + rAF loop to relocate
- `src/app/audio/[id]/annotate/[fileId]/wavesurfer-spectrogram.tsx` — current renderer; deleted in Phase 5; resample workaround at `:12`, hardcoded freq at `:189-194`, palette to extract at `:43-56`
- `src/app/audio/[id]/annotate/[fileId]/page.tsx` — Server Component; no changes needed
- `src/app/audio/annotation-actions.ts` — `createAudioDetection` already freq-aware (`:76-136`); add `updateAudioDetection` in Phase 4
- `src/lib/audio-resample.ts` — to delete in Phase 5
- `src/lib/birdnet-runner.ts:219-220` — BirdNET hardcodes 0/15000 (orthogonal; tracked under Phase 6)
- `src/components/bbox-overlay.tsx` — model for SVG hit-testing & drag UX (palette `:33-45`, `MIN_BOX_PX`, pointer-capture `:158`, label flipping `:300-330`)
- `src/db/schema.ts:781-803` — `audio_detections` schema (`minFreq`/`maxFreq` already non-null real)
- `src/hooks/use-audio-annotation-shortcuts.ts` — extension target for new shortcuts
- `docs/solutions/runtime-errors/spectrogram-process-explosion-AudioCache-20260226.md` — process-explosion lesson (informs why we're not adding any client-poll loop)
- `docs/brainstorms/2026-05-10-audio-spectrogram-redesign-brainstorm.md` — source brainstorm
- CLAUDE.md — Spanish UI strings, `ActionResult<T>`, `requirePermission()`, no `as string` on FormData, Drizzle Proxy `.bind` (memory: `proxy_db_drizzle_this_binding.md`)

### External — recommended libraries & references
- [fft.js](https://github.com/indutny/fft.js) — chosen FFT lib (~5 KB, ~10 µs/1024-FFT)
- [fft.js benchmarks](https://toughengineer.github.io/demo/dsp/fft-perf/) — performance budget basis
- [Mikhailov Turbo LUT](https://gist.github.com/mikhailov-work/ee72ba4191942acecc03fe6da94fc73f) — colormap source
- [matplotlib viridis/magma/inferno tables](https://github.com/BIDS/colormap/blob/master/colormaps.py) — colormap source
- [MDN canvas optimization](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas) — DPR + sub-pixel guidance
- [web.dev high-DPI canvas](https://web.dev/articles/canvas-hidipi) — DPR recipe
- [@ecoacoustics/web-components](https://github.com/ecoacoustics/web-components) — best modern reference for spectrogram annotators (Lit, but interaction patterns translate)
- [Casey Primozic — building a signal analyzer](https://cprimozic.net/blog/building-a-signal-analyzer-with-modern-web-tech/) — architecture writeup
- [WebAudio AnalyserNode + OfflineAudioContext is unreliable (#303)](https://github.com/WebAudio/web-audio-api/issues/303) — why we use a regular AudioContext
- [audio-decode (audiojs)](https://github.com/audiojs/audio-decode) — fallback for >10-min files (Phase 6)
- [Cornell Raven annotation patterns](https://www.ravensoundsoftware.com/knowledge-base/selection-review-and-annotation/) — keyboard model precedent
- [spectrolipi](https://github.com/nishantnnb/spectrolipi/) — UX inspiration
