# Audio Spectrogram Redesign — Brainstorm

**Date**: 2026-05-10
**Branch**: `feat/birdnet-audio-analysis` (WIP)
**Inspiration**: [nishantnnb/spectrolipi](https://github.com/nishantnnb/spectrolipi/)

## What We're Building

Replace wavesurfer.js's `SpectrogramPlugin` with a custom client-side FFT + canvas renderer for the audio annotation page (`src/app/audio/[id]/annotate/[fileId]/`). The goal is a faster, more controllable, freq-aware spectrogram annotator that takes ideas from spectrolipi while keeping FCAT's existing strengths (BirdNET pre-detections, species sidebar, deployment navigation).

### v1 must-haves

1. **Separate frequency-axis canvas** — dedicated left canvas (~70 px) draws Hz/kHz ticks independently of the spectrogram. Auto-formats `Hz` below 1 kHz, `kHz` above. Redrawn cheaply on resize/zoom without touching pixel data.
2. **Y-max clamp dropdown** — preset frequency ceilings (3/6/9/12 kHz / Nyquist). Re-renders from cached FFT magnitudes; no re-FFT, no resample.
3. **Time + frequency bounding boxes** — boxes store both time AND frequency bounds, drawn on a sibling canvas with 8 resize handles in editor mode. Replaces the current wavesurfer Regions fallback that hardcodes `minFreq: 0, maxFreq: 15000`.
4. **Live FFT / gain / colormap controls** — toolbar exposes FFT size (512/1024/2048), gain dB slider, dynamic range, colormap selector. Changes re-render the spectrogram without re-fetching audio.

### Deferred to v2

- Repeat-last-annotation (clone previous box dimensions)
- Hover magnifier lens (4× zoom on hover)
- Tabulator-style annotation grid with bulk species/tag updates
- BirdNET predictions panel with checkbox→insert flow

## Why This Approach

**Decision**: Client-side FFT + custom canvas stack, fully replacing wavesurfer's spectrogram plugin.

### Why not "keep wavesurfer + overlays on top"
Wavesurfer's plugin paints labels into the spectrogram pixels and offers no hook for y-axis units, ranges, or independent label canvases. The y-axis pain is structural, not stylistic. Overlays on top cannot fix it.

### Why not "server-rendered PNGs + canvas overlays"
Today's pipeline pre-generates spectrograms as PNGs (`/api/audio/spectrogram*`, `audio-cache.ts`). For a project that may accumulate hundreds of thousands of audio files, this is significant storage and ongoing pipeline complexity. The audio is already streamed for playback, so client-side FFT processes data the browser is fetching anyway — no extra download.

### Why client-side FFT wins for FCAT
- **No PNG storage** — drops the entire spectrogram-cache pipeline
- **Same data source** — playback and spectrogram share one decoded `AudioBuffer`; the playhead can never drift from the image
- **Live tunability** — FFT size, gain, colormap, y-max change instantly with no server round-trip
- **No "generating spectrogram…" loading state** — the polling loop in `annotation-client.tsx:181-225` disappears
- **CPU is fine** — 1-min mono @ 24 kHz with 1024-sample FFT ≈ 5,800 columns ≈ <300 ms on modern laptops
- **FCAT's audio files are short** — typical recording lengths fit comfortably in browser memory

### Tradeoffs we accept
- Long files (10+ min) may need windowed/lazy FFT — defer until a real file demands it
- We own the FFT (small library: `fft.js` or `kissfft-wasm`)
- Initial paint waits for audio decode rather than a small PNG fetch — but decode is needed for playback regardless

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Spectrogram source | Client-side FFT from decoded `AudioBuffer` | Eliminates PNG storage; enables live controls |
| Render target | Stacked HTML canvases (spectrogram / y-axis / x-axis / boxes / playhead / selection) | Independent redraws; matches spectrolipi's proven pattern |
| Wavesurfer | Remove from this page | Was only providing playback + spectrogram; both replaced. Native `AudioContext` + `<audio>` covers playback. |
| FFT library | `fft.js` (radix-2, pure JS) — pending validation | Mature, ~15 KB, no WASM toolchain needed |
| Default FFT size | 1024, Hann window | Standard for bird vocalizations |
| Default y-max | 12 kHz | Bird calls live below this; matches existing 24 kHz resample target |
| Box data model | Already supports `minFreq` / `maxFreq` (`AudioBoxData` in `wavesurfer-spectrogram.tsx:14-23`) | No schema changes needed |
| Scope of removal | Drop `/api/audio/spectrogram`, `/api/audio/spectrogram/meta`, `audio-resample.ts`, `audio-cache.ts` | Once client FFT lands, these have no callers |

## Open Questions

- **Audio decode failures**: how to handle Drive-streamed audio that fails to decode in the browser? (Currently the server-side step would catch this.)
- **Long files**: at what duration do we trigger windowed FFT instead of full-buffer? Probably >5 min, but pending real-world file sizes from FCAT recordings.
- **Colormap parity**: spectrolipi has 5 colormaps. Which feel right for bird audio? `viridis` and `magma` are standard; the current wavesurfer setup uses `roseus`.
- **Existing detections with `minFreq=0, maxFreq=15000`**: do we leave them as-is (legacy time-only), or backfill freq bands from BirdNET output where available?
- **Mobile / small screens**: not currently a target for this annotation page — confirm.
- **Keyboard shortcuts**: spectrolipi uses Tab/Shift+Tab to cycle annotations in time order. The current page already has hotkeys for species assignment and verification — does adding box-cycling conflict?

## Files Likely Touched

- **Replace**: `src/app/audio/[id]/annotate/[fileId]/wavesurfer-spectrogram.tsx` → new `client-spectrogram.tsx`
- **Edit**: `src/app/audio/[id]/annotate/[fileId]/annotation-client.tsx` — remove polling loop, swap component, wire new controls
- **Delete (after migration)**: `src/app/api/audio/spectrogram/route.ts`, `src/app/api/audio/spectrogram/meta/route.ts`, `src/lib/audio-cache.ts`, `src/lib/audio-resample.ts`, `src/app/audio/[id]/annotate/[fileId]/spectrogram-overlay.tsx`
- **Add**: client-side FFT util (`src/lib/audio-fft.ts`), colormap LUTs (`src/lib/spectrogram-colormaps.ts`)
- **Possibly**: `package.json` — drop `wavesurfer.js` if no other page uses it; add `fft.js`

## References

- [Spectrolipi GitHub](https://github.com/nishantnnb/spectrolipi/) — vanilla HTML/JS reference implementation
- [WebAudio AudioBuffer API](https://developer.mozilla.org/en-US/docs/Web/API/AudioBuffer)
- [fft.js](https://github.com/indutny/fft.js) — candidate FFT library
- Existing FCAT pattern: `src/app/audio/[id]/annotate/[fileId]/wavesurfer-spectrogram.tsx`
