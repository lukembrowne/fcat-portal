---
title: Audio Annotation Zoom & Density Improvements
type: feat
date: 2026-05-13
source_brainstorm: docs/brainstorms/2026-05-13-audio-annotation-zoom-density-brainstorm.md
---

# Audio Annotation Zoom & Density Improvements

## Overview

The audio annotation page becomes hard to read when a 60-second recording carries many BirdNET detections — species labels overlap, boxes pile up at the 0–15 kHz band, the 256 px spectrogram is too short to read fine call structure, and clicking a card in the sidebar doesn't surface its box in the dense overlay.

This plan adds four incremental, independently shippable enhancements to the spectrogram viewer at `src/app/audio/[id]/annotate/[fileId]/`:

1. **Resizable spectrogram height** — Compacto / Cómodo / Alto toggle, persisted per browser.
2. **Time-axis zoom + horizontal scroll** — 1× / 2× / 4× / 8× with sticky frequency axis, follow-the-playhead, card-click auto-scroll.
3. **Smart label handling** — at low zoom, labels collapse to a colored letter chip with hover tooltip; at high zoom they expand to full text.
4. **Lane stacking for overlapping detections** — overlapping boxes get assigned to tiered y-lanes so each is independently visible.

The work is purely client-side React/Canvas/SVG — no schema changes, no server actions, no API surface changes. Rollout is phased so each phase can be evaluated by field-team users before the next ships.

## Problem Statement / Motivation

Source brainstorm: `docs/brainstorms/2026-05-13-audio-annotation-zoom-density-brainstorm.md`.

Reproducer: open any 1-minute audio file with ≥20 BirdNET detections (e.g. `SEC-006_V1 / 2MM21799_20260207_080000.flac` referenced in the brainstorm screenshot). Symptoms:

- 25+ labels truncate to 3 letters and overlap horizontally (`Schi Schi Long Long Cryp …`).
- All detection boxes span 0–15 kHz, so they visually stack on top of each other at the top of the spectrogram.
- 256 px spectrogram body is too short to read individual call harmonics.
- Clicking a card in the sidebar selects a box but doesn't visually pull it out of the pile.

The screenshot use case is exactly the data the verification team works through daily for the BIOCHOCO project. Without a fix, accuracy of human verification drops as detections-per-file grows.

## Proposed Solution

Refactor `fft-spectrogram.tsx` (and its co-located `annotation-client.tsx` + `spectrogram-controls.tsx`) to support a configurable height and a discrete time-axis zoom with horizontal scrolling. Extract pure helpers (coordinate math, lane assignment, label-collapse decision) to a new testable module `src/lib/spectrogram-layout.ts`. Add settings + persisted preferences under a bumped `audio.spectrogram.v2` localStorage key with safe migration from `v1`.

Ship in four phases; each one is independently useful and can be deployed before the next begins.

## Technical Approach

### Architecture

Current DOM (`fft-spectrogram.tsx:828–1060`):

```
<div class="relative flex w-full">
  <FreqAxis width=70 height=SPEC_HEIGHT />          ← sibling, not in scroll container
  <div class="flex-1 min-w-0 flex flex-col">
    <div style={{ height: SPEC_HEIGHT, width: specSize.width }}>
      <canvas ref={specCanvasRef} class="absolute inset-0" />
      <svg viewBox="0 0 1 1" preserveAspectRatio="none">
        {boxes.map(box => <rect ... vectorEffect="non-scaling-stroke" />)}
      </svg>
      <div>{labels.map(...)}</div>           ← HTML divs, left: X%
      <div ref={playheadRef} style={{ transform: translateX(...) }} />
    </div>
    <canvas ref={timeAxisCanvasRef} height={24} />
  </div>
</div>
```

Target DOM (after Phase 2):

```
<div class="relative flex w-full">
  <FreqAxis width=70 height={spectrogramHeight} />          ← stays sibling, never scrolls
  <div class="flex-1 min-w-0 flex flex-col overflow-x-auto">  ← NEW: horizontal scroll viewport
    <div style={{ width: baseWidth * zoom, height: spectrogramHeight }}>  ← grows with zoom
      <canvas style={{ width: '100%', height: '100%' }} />   ← CSS-stretched (Phase 2 v1)
      <svg viewBox="0 0 1 1" preserveAspectRatio="none">…</svg>
      <div>{labels.map(...)}</div>
      <div ref={playheadRef} />
    </div>
    <canvas height={24} style={{ width: baseWidth * zoom }} />  ← time axis widens
  </div>
</div>
```

The freq-axis stays a flex sibling **outside** the scrollable inner viewport. Time-axis lives inside the scroll viewport so its tick labels stay aligned with the spectrogram body. The SVG `viewBox="0 0 1 1" preserveAspectRatio="none"` + `vectorEffect="non-scaling-stroke"` already make rect scaling clean. HTML labels position with percent-based `left:X%` and need no math change to scale with the zoomed container — only their collapse/expand decision changes (Phase 3).

### Files Affected

| File | Change |
|---|---|
| `src/lib/spectrogram-layout.ts` | **NEW.** Pure helpers: `assignLanes()`, `decideLabelCollapse()`, `viewportToTime()`, `timeToScrollOffset()`, `withinViewportTailZone()`. Vitest-testable in node env. |
| `src/app/audio/[id]/annotate/[fileId]/fft-spectrogram.tsx` | Replace `SPEC_HEIGHT` constant with prop; wrap spec body in scroll container; thread zoom + scroll state; add playhead follow logic; render lanes; collapsible labels. |
| `src/app/audio/[id]/annotate/[fileId]/annotation-client.tsx` | Update popover anchor math (`:389–417`) to factor in zoom + scroll offset; subscribe popover to scroll/resize; thread height + zoom settings down. |
| `src/app/audio/[id]/annotate/[fileId]/spectrogram-controls.tsx` | Add height toggle, zoom dropdown, follow-playback toggle. Bump `STORAGE_KEY` to `audio.spectrogram.v2` with safe v1→v2 migration. |
| `src/lib/spectrogram-settings.ts` | **NEW.** Extract settings type + load/save/migrate from `spectrogram-controls.tsx` for re-use and testability. |
| `src/hooks/use-audio-playback-shortcuts.ts` | Add `+ / - / 0` zoom shortcuts (Alt-modifier to avoid browser-zoom conflict); add `Shift+←/→` horizontal scroll. |
| `tests/unit/lib/spectrogram-layout.test.ts` | **NEW.** Unit tests for lane assignment, label-collapse decision, viewport math. |
| `tests/unit/lib/spectrogram-settings.test.ts` | **NEW.** Unit tests for v1→v2 migration, malformed JSON handling. |

No DB schema, no server actions, no API routes touched. Spanish UI strings only.

### Constants Sourcing

Today `FREQ_AXIS_WIDTH = 70` is duplicated at `fft-spectrogram.tsx:25` AND `annotation-client.tsx:393`. Extract to `src/lib/spectrogram-layout.ts`:

```ts
// src/lib/spectrogram-layout.ts
export const FREQ_AXIS_WIDTH = 70;
export const TIME_AXIS_HEIGHT = 24;
export const SPEC_HEIGHT_PRESETS = {
  compacto: 256,
  comodo: 350,
  alto: 480,
} as const;
export const ZOOM_LEVELS = [1, 2, 4, 8] as const;

// Derive literal types from the const arrays — never hand-write the unions.
// (Per Kieran review: avoids drift between two sources of truth.)
export type HeightPreset = keyof typeof SPEC_HEIGHT_PRESETS;
export type ZoomLevel = typeof ZOOM_LEVELS[number];
```

Both consumers import from one source. **Never hand-write `1 | 2 | 4 | 8` or `"compacto" | "comodo" | "alto"` elsewhere** — always import `HeightPreset` / `ZoomLevel`.

### Component API

`<FftSpectrogram>` gets a single grouped `viewState` prop rather than three loose ones (per Kieran review — keeps the prop surface flat and future-additions cheap):

```ts
type SpectrogramViewState = {
  height: HeightPreset;
  zoomLevel: ZoomLevel;
  followPlayback: boolean;
};

<FftSpectrogram
  viewState={viewState}
  onViewStateChange={setViewState}
  // …existing props (audioUrl, boxes, editable, gainDB, rangeDB, fftSize, colormap, callbacks)
/>
```

Do NOT introduce a `SpectrogramContext` for this — only two consumers (`annotation-client.tsx` and `<FftSpectrogram>`) and Context would re-render on every scroll tick. Prop-drill is correct here.

### Server / Client Boundary

The annotate page lives under App Router at `src/app/audio/[id]/annotate/[fileId]/page.tsx` (Server Component). The interactive layer is `annotation-client.tsx`, which already carries the `'use client'` directive. All new state added by this plan lives in client components:

- `spectrogram-controls.tsx` — client (settings UI + localStorage)
- `fft-spectrogram.tsx` — client (canvas + SVG + state)
- `src/lib/spectrogram-layout.ts` — **isomorphic pure functions** (no React, no DOM). Imported by both. No `'use client'` directive needed.
- `src/lib/spectrogram-settings.ts` — **mostly isomorphic** (types + pure migrate helpers) plus one client-only React hook `useSpectrogramSettings()` that wraps `useSyncExternalStore`. The hook is the only piece that requires `'use client'`.

No server component touches `localStorage`. SSR renders the initial page; the client mounts with default settings (via `getServerSnapshot`); the `useSyncExternalStore` subscription hydrates from `localStorage` on the first effect tick. Accept the one-frame default-state flash — same tradeoff as `deployments-table.tsx`.

## Phase 1 — Resizable Spectrogram Height

### Tasks

1. **Extract `FREQ_AXIS_WIDTH`, `TIME_AXIS_HEIGHT`, `SPEC_HEIGHT_PRESETS` to `src/lib/spectrogram-layout.ts`.**
2. **Replace `SPEC_HEIGHT` constant** (`fft-spectrogram.tsx:27`) with a `height` prop sourced from settings.
3. **Add height toggle** to `spectrogram-controls.tsx`:
   - 3-button group: `Compacto` / `Cómodo` / `Alto` (Spanish per CLAUDE.md).
   - Visible icon-only at narrow widths, full label at wide.
4. **Add settings persistence** via the discriminated union described in Cross-Cutting → Persistence. Storage key stays `audio.spectrogram` (version is encoded inside the JSON via the `version` discriminator field, per Kieran review). Pre-existing v1 payloads pass through `migrate()` and round-trip cleanly. Wrap reads in try/catch — on parse error, fall back to `DEFAULT_SETTINGS`.
5. **Update `annotation-client.tsx`** to read height from settings and pass `height` prop to `<FftSpectrogram>`. Popover anchor uses `specPx.height` from `onSpecSizeChange` callback (already wired) — no math change here.
6. **Mobile cap**: at viewport < 640 px (Tailwind `sm`), force `compacto` regardless of preference; show toggle as disabled with a tooltip "Disponible en pantallas más anchas".

### Acceptance Criteria

- [x] Toggle renders in settings panel with three options in Spanish. (`HeightToggle` in `spectrogram-controls.tsx`)
- [x] Switching height preserves all other state (zoom, gain, FFT size, selected box). (`update()` spreads existing settings)
- [x] Height persists across reload via `localStorage`. (`saveStoredSettings` on every change via `useEffect`)
- [x] `migrate()` on a v1 payload produces a v2 payload with `spectrogramHeight: "comodo"`, `zoomLevel: 1`, `followPlayback: true` defaults. Other v1 fields preserved byte-for-byte. Unit-tested.
- [ ] No layout regression on the annotate page at any of the three heights — sidebar, sticky controls, popover all behave correctly. **Test with sidebar open** (per `docs/solutions/ui-bugs/biochoco-overview-horizontal-scroll-map-overlap.md`). _(manual verify pending)_
- [x] On `sm` viewports the toggle is disabled and forces `compacto`. (`useIsNarrowViewport` hook + `isNarrowViewport ? "compacto" : settings.spectrogramHeight` clamp in `annotation-client.tsx`)
- [x] Spectrogram canvas re-renders at correct DPR-scaled pixel dimensions when height changes (`specHeight` added to ResizeObserver `useEffect` deps).
- [ ] Frequency axis labels (5 kHz, 10 kHz, etc.) re-distribute vertically without overlapping or clipping at any height. _(manual verify pending — freq-axis effect already depends on `specSize.height`, which propagates from the new `specHeight`)_

### Gotchas

- `sizeCanvas()` at `fft-spectrogram.tsx:123` applies `window.devicePixelRatio`. Verify the canvas reallocates on height change (the `ResizeObserver` at `:391` only watches width).
- The frequency-axis canvas at `:329` redraws on `[specSize, displayMaxHz]` — extend its deps to include `height`.
- Popover anchor reads `specPx.height` from a callback; if it caches a stale height, the popover floats. Verify the callback fires after height change.

### Testing

- Unit: settings migration (`v1` → `v2`, malformed JSON, missing field) in `tests/unit/lib/spectrogram-settings.test.ts`.
- Manual: switch height while paused, while playing, with selected box, with popover open. Screenshot each.

---

## Phase 2 — Time-Axis Zoom & Horizontal Scroll

### Tasks

1. **Add `zoomLevel` to settings**: `1 | 2 | 4 | 8` (v2 settings type).
2. **Wrap spectrogram body in scrollable viewport** as described in Architecture. Apply `min-w-0` to all flex children in the chain (per documented biochoco gotcha) and `overflow-y: hidden` explicitly alongside `overflow-x: auto`.
3. **Widen inner container** to `baseWidth × zoomLevel`. The base width is the freq-axis-subtracted available width from the existing `ResizeObserver`.
4. **CSS-stretch the canvas**: `style={{ width: '100%', height: '100%' }}` on the existing `specCanvasRef` canvas; the underlying canvas resolution stays at base × DPR (acceptable at 1×–4×; flag in v2 if 8× looks unusable).
5. **Widen the time-axis canvas** by `zoomLevel`. Recompute tick density so labels stay readable: target ~80 px between labels regardless of zoom, so 4× shows roughly 4× more ticks than 1×.
6. **Add zoom dropdown** to `spectrogram-controls.tsx`: "Zoom: 1× / 2× / 4× / 8×".
7. **Keyboard shortcuts** in `use-audio-playback-shortcuts.ts`:
   - `Alt+=` / `Alt++` → zoom in one step
   - `Alt+-` → zoom out one step
   - `Alt+0` → reset to 1×
   - `Shift+←` / `Shift+→` → scroll viewport by 25% of viewport width
   - Bail out if focus is on an input/textarea (existing guard pattern).
   - Use `Alt` (not bare `+` `-`) to avoid conflict with browser Cmd+`+/-` zoom.
8. **Scroll-wheel zoom with modifier**: on `wheel` event with `event.ctrlKey || event.metaKey`, call `event.preventDefault()` and step the zoom level. Throttle to one zoom step per animation frame.
9. **Cursor-anchored zoom**: when zooming in, compute the time `t` under the cursor at the moment of the wheel event; after zoom, set scroll offset so that `t` lands under the same screen x. Same on dropdown / keyboard zoom centered on viewport center.
10. **Card-click auto-scroll**: in `annotation-client.tsx`, when `selectedDetectionId` changes, compute the box's center time, call `scrollIntoView` style behavior on the scroll container with `behavior: prefers-reduced-motion ? 'instant' : 'smooth'`, 300 ms ease-out. Clamp to `[0, scrollWidth - viewportWidth]`. Pulse the box (CSS `data-just-selected` class, 500 ms scale+opacity flash).
11. **Follow-the-playhead during playback**:
   - Compute `tailZone = viewport[scrollLeft + 0.8 × viewportWidth, scrollLeft + viewportWidth]`.
   - On the existing playhead-rAF loop, if `playheadX > tailZone.start` and `followMode === true`, smooth-scroll to center the playhead.
   - Add a `Seguir reproducción` toggle in controls (default on); persist in v2 settings.
   - Manual user scroll while playing → temporarily pause follow mode until next `seek` or `playSelection` call. Detect via a `wheel`/`scroll` listener that flips a `followPausedByUser` flag.
12. **Window resize handling**: on container width change, preserve the **time region currently centered** in the viewport (not the scroll px offset). Implementation: compute `centerTime` before resize, recompute scroll offset after resize so `centerTime` lands under the new center x.
13. **Extract popover anchor coord math into `src/lib/spectrogram-layout.ts`** (per Kieran review — currently duplicated at `annotation-client.tsx:389–417` and inside the spectrogram component). New pure helper:
    ```ts
    // src/lib/spectrogram-layout.ts
    export function anchorBoxToViewportPx(
      box: { startTime: number; endTime: number; minFreq: number; maxFreq: number },
      view: { duration: number; scrollLeft: number; scrollWidth: number; specHeight: number; displayMaxHz: number },
    ): { x: number; y: number; w: number; h: number };
    ```
    Both `annotation-client.tsx` and the spectrogram's internal SVG layer call this — single source of truth.
14. **Wire popover to scroll + zoom**:
    - Anchor recomputed from `anchorBoxToViewportPx` on each `scroll` event (rAF-batched) and zoom change.
    - Close the popover if anchor leaves the visible viewport.
    - Use a ref counter `programmaticScrollDepth.current` (increment before `scrollTo`, decrement in next-frame). Boolean flag (per the plan's earlier draft) races when card-click happens during smooth-scroll — Kieran review flagged this.
15. **Render virtualization for SVG boxes + HTML labels** (performance):
    - At each render, compute `visibleTimeWindow = [scrollLeft / scrollWidth × duration - pad, (scrollLeft + viewportWidth) / scrollWidth × duration + pad]` with `pad = 1 × viewportTime`.
    - Filter detections to those whose `[start, end]` intersects this window. Memoize via `useMemo` keyed on `(detectionsVersion, scrollSignature)` — see "Memoization Contract" below.
    - Re-filter on scroll (rAF-batched) and on detections-changed.
16. **Scroll-spy sidebar highlight** (optional polish): on viewport scroll, set the sidebar's "current" highlight to the first detection whose start time falls inside the visible window. Already covered by `selectedDetectionId` for clicks — this just adds passive scroll-spy.

### Memoization Contract

Per Kieran review: any `useMemo` keyed on the `boxes` array reference is a foot-gun — parent re-renders that build `boxes` via `.filter()` or `.map()` mint a fresh array on every keystroke and bust the memo. To prevent this:

- The parent (`annotation-client.tsx`) owns a `detectionsVersion: number` counter, incremented whenever the detection set mutates (insert / delete / update verification status). Passed alongside `boxes`.
- All downstream `useMemo` calls in `<FftSpectrogram>` key on `detectionsVersion` (not on `boxes` itself). The actual `boxes` array can be a fresh literal each render — only the version key matters for memo invalidation.
- The lane assignment (Phase 4) and virtualized-box filter (this task) both follow this pattern.

This contract is documented in `src/lib/spectrogram-layout.ts` at the top of `assignLanes()`.

### Acceptance Criteria

- [ ] Zoom dropdown changes spectrogram body width to `base × zoomLevel`.
- [ ] Frequency axis stays fixed at left edge regardless of horizontal scroll.
- [ ] Time-axis tick labels stay aligned with the spectrogram canvas at every zoom level.
- [ ] SVG detection boxes scale cleanly (no stretched strokes, no skewed text).
- [ ] HTML labels reposition correctly when scrolling.
- [ ] Playhead position remains accurate during playback at every zoom level.
- [ ] `Alt+=` / `Alt+-` / `Alt+0` zoom shortcuts work; do not fire while typing in inputs.
- [ ] `Ctrl/Cmd+wheel` zooms while preventing browser zoom.
- [ ] Mouse-wheel zoom keeps the time region under the cursor anchored.
- [ ] Card click in sidebar auto-scrolls the matched box to the center of the viewport and pulses it.
- [ ] Playback cursor stays visible while `Seguir reproducción` is on; manual scroll pauses follow until next play/seek.
- [ ] Window resize preserves the centered time region (not the px offset).
- [ ] Popover species picker follows the box across zoom and scroll; closes when anchor leaves viewport.
- [ ] SVG rect count rendered = visible boxes only (verify via React DevTools or a perf trace).
- [ ] At 1× / 2× / 4× / 8× on a 60-second file with 50 detections: zoom transition completes in < 100 ms.
- [ ] No layout regression with the sidebar open on a 1280-wide viewport.

### Gotchas

- **`min-w-0` is required on every flex child in the chain** down to the scroll container, per `docs/solutions/ui-bugs/biochoco-overview-horizontal-scroll-map-overlap.md`. Without it, `flex-1` refuses to shrink below intrinsic content width and the scroll never engages.
- **Browser Cmd+/-** zoom captures `Cmd+=` and `Cmd+-` system-wide. Use `Alt+=` / `Alt+-` to avoid the conflict. (Mac Safari may also map Cmd+/-; Alt is portable.)
- **`Ctrl/Cmd+wheel`** is the standard "zoom" gesture and is *also* what browsers use for page zoom — must `preventDefault()` exactly when the spectrogram is the target.
- **Trackpad pinch** generates a `wheel` event with `ctrlKey: true` on Mac. This means pinch-to-zoom is implicitly handled by the modifier-wheel listener. Test on Mac trackpad.
- **`scrollLeft` is integer-rounded** in some browsers — small zoom math may drift by a pixel. Use `Math.round` consistently and accept ≤1 px drift.
- **`scrollTo({ behavior: 'smooth' })`** is async — don't try to read scrollLeft until the next frame.
- **Playhead follow vs manual scroll race**: a `scroll` listener can't distinguish user scroll from programmatic smooth-scroll. Use a ref counter (`programmaticScrollDepth.current++` before `scrollTo`, `--` in the next frame) — *not* a boolean. Per Kieran review, the boolean races when two programmatic scrolls overlap (e.g. card-click during smooth-scroll).
- **DPR-aware canvas**: the existing `sizeCanvas()` doubles the canvas's internal pixel buffer for retina. When CSS-stretched 4× wider, the internal buffer is still base × DPR — so effective pixel density falls 4×. This is the v1 tradeoff documented in the brainstorm; revisit if blurry at 4×.

### Testing

- Unit (`tests/unit/lib/spectrogram-layout.test.ts`):
  - `viewportToTime(scrollLeft, viewportWidth, scrollWidth, duration)` round-trips.
  - `timeToScrollOffset(t, zoom, baseWidth, duration, viewportWidth)` centers correctly at boundaries (t=0, t=duration).
  - `withinViewportTailZone(playheadX, scrollLeft, viewportWidth)` returns true only in last 20%.
- Manual checklist:
  - 60-second file, 50 detections, zoom 1× → 8× via each input method.
  - Card-click each of 5 random detections at zoom 4×; verify all scroll into view and pulse.
  - Play from t=0; verify follow-mode keeps playhead visible at zoom 4×.
  - Manually scroll while playing; verify follow pauses; press play/seek to resume.
  - Resize browser from 1920 → 1280 wide at zoom 4×; verify center time stays.
  - Open species picker popover at zoom 4×; scroll and verify it follows.
  - Sidebar open vs closed at zoom 8× — no horizontal overflow on the page itself.

---

## Phase 3 — Smart Label Handling

### Tasks

1. **Add `decideLabelCollapse(boxWidthPx, zoomLevel, isSelected)` helper** to `src/lib/spectrogram-layout.ts`. Returns `'collapsed' | 'expanded'`. Threshold: `boxWidthPx × zoomLevel < 40` → collapsed, else expanded. Selected boxes always expanded.
2. **Render two label modes** in `fft-spectrogram.tsx`:
   - **Expanded** (current behavior): pill with full species name, color background.
   - **Collapsed**: 14 px × 14 px square color chip with the first letter of the species (e.g., `S` for Schiffornis). `aria-label` and `title` carry the full species name for screen readers and hover tooltip.
3. **Hover tooltip**: a single hover handler on the box rect (already exists) renders a portal-positioned tooltip near the cursor with the full species name + confidence. Same tooltip used in both modes.
4. **Pulse animation** on card-click (also used by auto-scroll in Phase 2). CSS animation: 500 ms scale 1 → 1.06 → 1 + ring opacity 0.6 → 0. Apply via a `data-pulse-key={n}` attribute where `n` is an incrementing counter from a `usePulseKey()` hook (NOT a timestamp — per Kieran review, React skips renders when the same timestamp re-occurs and clock-skew makes timestamps untestable). The counter increments on every card-click event, which forces React to swap the DOM attribute and re-trigger the `@keyframes pulse-box` animation. Respect `prefers-reduced-motion`: skip animation, no scroll behavior change.
5. **Collapsed chip WCAG**: include the first letter (not just color), satisfying WCAG 1.4.1.

### Acceptance Criteria

- [ ] At zoom 1× with many short detections, labels render as letter chips, not pills.
- [ ] At zoom 4×+ or selected, labels render as full pills.
- [ ] Hover on a chip or pill shows a tooltip with full species name + confidence.
- [ ] Screen reader announces full species name on chip focus (`aria-label`).
- [ ] Pulse animation plays on card-click, suppressed under `prefers-reduced-motion: reduce`.
- [ ] Existing selected-box behavior (border thicker, label always expanded) still works.

### Gotchas

- The label container today uses `maxWidth` to truncate — collapsed chips need explicit `width` + `height` + zero `maxWidth` constraint, not just CSS truncation.
- First-letter extraction must be locale-safe (`species.normalize('NFD')[0]`) — but BirdNET species names are ASCII, so this is belt-and-suspenders.
- Tooltip positioning must respect viewport bounds (no off-screen on left edge or right edge).

### Testing

- Unit: `decideLabelCollapse` decision matrix (small box / large box / small box selected / very small box at high zoom).
- Manual: zoom 1× → 8× with 20+ detections; verify smooth label-mode transition at each step; tab through chips with screen reader.

---

## Phase 4 — Lane Stacking for Overlapping Detections

### Tasks

1. **Implement `assignLanes(detections, detectionsVersion)` in `src/lib/spectrogram-layout.ts`**:
   - Sort detections by `(startTime, endTime, id)` — id as final tiebreaker for stability.
   - Greedy first-fit: for each detection, place in the lowest-indexed lane whose last occupant ends before this detection starts.
   - Return a tagged-union assignment (per Kieran review — don't overload `laneCount`):
     ```ts
     export type LaneAssignment =
       | { mode: 'full' }                                              // not overlapping anything
       | { mode: 'lanes'; laneIndex: number; laneCount: number }       // member of an overlap group
       | { mode: 'dense'; groupSize: number };                         // > 12 lanes — fallback
     export function assignLanes(
       detections: readonly DetectionBox[],
       detectionsVersion: number,
     ): ReadonlyMap<string, LaneAssignment>;
     ```
   - **Lane assignment scope:** compute lanes only over the set of detections that *actually overlap* something. Non-overlapping detections get `mode: 'full'`.
   - **Per-group locality:** compute lane *groups* (connected components in the overlap graph); each group's `laneCount` is local to that group. Avoids one huge cluster forcing every box into N lanes globally.
2. **Render boxes by mode** in `fft-spectrogram.tsx` — exhaustive switch on the tagged union:
   - `mode: 'full'` → render at full frequency range as today.
   - `mode: 'lanes'` → compute `laneHeight = freqRangePx / laneCount`, offset y by `laneIndex × laneHeight`, 2 px vertical padding between lanes.
   - `mode: 'dense'` → render at full frequency range as today (current overlapping behavior preserved); emit `console.warn('[spectrogram] dense lane fallback', { groupSize })` at most once per group. **No user-facing badge** — Kieran review flagged the "Muchas detecciones" badge as product noise. Pathological-case logging is for us, not for users.
3. **Memoize `assignLanes` output** with `useMemo` keyed on `detectionsVersion` (NOT on the `boxes` array reference — see Memoization Contract in Phase 2). Recompute only when the parent's counter increments.
4. **Stability across mutations**: id-sorted greedy fit means appending a new detection that doesn't overlap existing ones never changes their lane assignments. Tested via unit test.
5. **Lane labels**: defer to a future v2. v1 is purely visual.

### Acceptance Criteria

- [ ] Overlapping detections are visually stacked into lanes; no two overlapping boxes draw on top of each other.
- [ ] Non-overlapping detections still render full-height (matches current behavior).
- [ ] Lane assignment is stable: deleting / re-adding a detection that doesn't overlap others does not shift lane assignments of unrelated detections.
- [ ] Lane assignment respects per-group locality: a 3-detection overlap cluster does not get pushed into 12 lanes just because some other cluster elsewhere has 12.
- [ ] At > 12 lanes per group, fallback `mode: 'dense'` renders and emits one `console.warn` per group (no user badge).
- [ ] Lane stacking interacts cleanly with zoom (lanes recompute only when `detectionsVersion` increments — zoom alone doesn't change lane assignment, only the per-lane pixel height).

### Gotchas

- BirdNET detections all span 0–15 kHz and use 3-second sliding windows starting every 1–2 seconds. Most detections will overlap → most groups will be moderately deep. The 12-lane cap is defensive coding; we'll measure dawn-chorus files to see if it ever fires.
- The frequency axis label positioning (5/10/15 kHz) is independent of lanes — lanes are purely a render concern.
- User-created boxes (drag-to-create in editable mode) can be added mid-session. The memoized `assignLanes` recomputes when `detectionsVersion` ticks; brief flicker is acceptable.
- The renderer's switch on `LaneAssignment.mode` must be **exhaustive** — TypeScript's `never` assertion in the `default` branch catches missed cases.

### Testing

- Unit (`tests/unit/lib/spectrogram-layout.test.ts`):
  - 3 fully-overlapping detections → 3 lanes (all `mode: 'lanes'`).
  - 3 sequential detections → all `mode: 'full'`.
  - 5 detections, 2 overlap cluster + 3 separate → cluster gets `mode: 'lanes'` with `laneCount: 2`, separates get `mode: 'full'`.
  - Stability: append a new non-overlapping detection → existing assignments byte-identical.
  - 13 detections all overlapping → all get `mode: 'dense'` with `groupSize: 13`.
- Manual: open a known-busy file (e.g., the screenshot file `SEC-006_V1 / 2MM21799_…`); verify lanes activate; verify selected-box pulse still works inside a lane.

---

## Resolved Open Questions

The brainstorm flagged six open questions. Resolutions baked into this plan:

| Question | Resolution | Rationale |
|---|---|---|
| Pinch-to-zoom on Mac trackpads? | **Implicit support** via `Ctrl+wheel` (trackpad pinch already emits `ctrlKey: true`). No additional gesture code. | Free behavior; matches user mental model. |
| Mini-map / overview strip? | **Deferred to v2.** | Adds complexity; card-click auto-scroll covers the main orientation use case. |
| Lane stacking always vs only on overlap? | **Only when overlapping** within a connected group. | Preserves current visual at low density; minimizes visual noise. |
| Max zoom level? | **8× in v1.** Revisit for longer (5-min) clips. | 60-s clip × 8× = 480 px-per-sec; readable. 5-min clip × 8× = 2400 s of scrolling — acceptable but on the edge. |
| CSS scaling vs FFT recompute? | **CSS scaling v1.** | Cheaper, ships faster. Acceptable to ~4×; flag 8× quality in user testing. FFT recompute is the v2 escape hatch. |
| Lane labels (piano-roll style)? | **Pure visual v1; defer labels to v2.** | Most users will identify species via the box label already; lane labels add layout complexity. |

## Cross-Cutting Decisions

### Persistence

Settings live under localStorage key `audio.spectrogram` (no version suffix — version is encoded inside the JSON as a discriminator field, per Kieran review). The shape is a discriminated union so the migrate function can exhaustive-switch on `version`:

```ts
// src/lib/spectrogram-settings.ts

import { type HeightPreset, type ZoomLevel } from "./spectrogram-layout";

export type StoredSettings =
  | {
      version: 1;
      displayMaxHz: number;
      gainDB: number;
      rangeDB: number;
      fftSize: number;
      colormap: string;
    }
  | {
      version: 2;
      displayMaxHz: number;
      gainDB: number;
      rangeDB: number;
      fftSize: number;
      colormap: string;
      spectrogramHeight: HeightPreset;
      zoomLevel: ZoomLevel;
      followPlayback: boolean;
    };

export type CurrentSettings = Extract<StoredSettings, { version: 2 }>;

export const DEFAULT_SETTINGS: CurrentSettings = {
  version: 2,
  displayMaxHz: 15000,
  gainDB: 3,
  rangeDB: 30,
  fftSize: 2048,
  colormap: "grayscale",
  spectrogramHeight: "comodo",
  zoomLevel: 1,
  followPlayback: true,
};

export function migrate(stored: StoredSettings): CurrentSettings {
  switch (stored.version) {
    case 1:
      return { ...stored, version: 2, spectrogramHeight: "comodo", zoomLevel: 1, followPlayback: true };
    case 2:
      return stored;
    default: {
      const _exhaustive: never = stored;  // catches missed cases at compile time
      return DEFAULT_SETTINGS;
    }
  }
}

export function loadStoredSettings(): CurrentSettings { /* try/catch + migrate */ }
```

Notice: `HeightPreset` and `ZoomLevel` come from `spectrogram-layout.ts` so they stay in sync with the const arrays. No hand-written `1 | 2 | 4 | 8` anywhere.

**React subscription:** the settings hook uses `useSyncExternalStore` (per Kieran review — handles cross-tab updates cleanly and avoids the hydrate-in-effect flash for callers that opt in):

```ts
// src/lib/spectrogram-settings.ts (client-only section)
"use client";
import { useSyncExternalStore } from "react";

export function useSpectrogramSettings(): readonly [
  CurrentSettings,
  (next: CurrentSettings) => void,
] {
  const settings = useSyncExternalStore(
    subscribe,           // listens to 'storage' event for cross-tab sync
    getSnapshot,         // reads localStorage
    getServerSnapshot,   // returns DEFAULT_SETTINGS during SSR
  );
  return [settings, saveSettings] as const;
}
```

- Save is debounced 300 ms to avoid thrashing during slider drags.
- localStorage write wrapped in try/catch (private-mode Safari, quota-exceeded → silent fallback to in-memory).
- **Per-browser, not per-user-account** — matches existing pattern. Multiple FCAT staff sharing a workstation share prefs. Documented in the hook's docstring.

### Accessibility

- All new buttons / dropdowns / toggles have visible labels in Spanish and `aria-label`s where icon-only.
- Pulse animation, smooth scroll, and any other motion respect `prefers-reduced-motion: reduce` — fall back to instant.
- Collapsed label chips include the first letter (not just color) per WCAG 1.4.1.
- Keyboard shortcuts: `Alt+=` / `Alt+-` / `Alt+0` for zoom; `Shift+←` / `Shift+→` for horizontal scroll. Listed in the existing `Ayuda y atajos` dialog.
- Focus management on auto-scroll: focus stays on the sidebar card; the spectrogram box receives `aria-current="true"`.

### Performance

- SVG + HTML label virtualization at scroll viewport ± 1 viewport pad. Memoized per `(detectionsVersion, scrollSignature)`.
- Lane assignment memoized per `detectionsVersion` counter (NOT per array reference — see Phase 2 Memoization Contract).
- localStorage writes debounced 300 ms.
- Zoom-change repaint: target < 100 ms on a 60-s file with 50 detections.

### Internationalization

- All new strings hardcoded Spanish per CLAUDE.md: `Compacto`, `Cómodo`, `Alto`, `Zoom`, `Acercar`, `Alejar`, `Restablecer zoom`, `Seguir reproducción`. (No `Muchas detecciones` string — the dense-fallback case logs to console, not to the UI.)

### Backwards Compatibility

- `v1` settings auto-migrate to `v2`; missing fields take their defaults.
- The `<FftSpectrogram>` component's external API (props + imperative ref methods) stays backward compatible. New props (`height`, `zoomLevel`, `onScrollChange`) have safe defaults.

## Edge Case Handling

Resolutions for gaps surfaced by spec-flow analysis:

| Edge case | Resolution |
|---|---|
| Drag-to-create at zoom 8× | Coordinate math operates on normalized `nx, ny` inside the scrolled body — works as-is. |
| Resizing/dragging box across viewport edge | When pointer reaches viewport edge during drag, smooth-scroll viewport in that direction at 200 px/s until pointer moves back or pointer release. |
| Delete a box that's currently pulsing | Pulse animation cancels via React unmount; focus moves to next detection card in sidebar (existing handler). |
| Switching `[fileId]` while zoomed | Zoom and height persist (localStorage). Scroll position resets to 0 — new file, new content. |
| Loading state at zoom 8× | Placeholder fills the scroll container at current zoom width with skeleton shimmer. |
| Detection with `start = 0` or `end = duration` | `scrollIntoView` clamps to `[0, scrollWidth - viewportWidth]`. |
| Single-pixel collapsed chip | Minimum chip width 14 px with 4 px invisible padding on each side for hit area (24 px total). |
| 500+ overlapping detections | 12-lane cap; fallback dense mode with badge. |
| Identical start times | Sort tiebreaker is `(start, end, id)` — deterministic. |
| 8× canvas blur on long files | Accepted v1 tradeoff; flag in user-testing; FFT-recompute escape hatch in v2. |
| Cmd+wheel double-fires | `event.preventDefault()` consumes; rAF-batched zoom step ensures one step per frame. |
| localStorage full / private mode | Try/catch around writes; silent fallback to in-memory defaults for the session. |
| Malformed v1 JSON | Parse error → use defaults, log a warning. |
| Card-click → auto-scroll → follow-mode race | Card-click scroll wins; follow-mode pauses until next play/seek event. |
| Window resize while zoomed | Preserve centered time region, not pixel offset. |
| BirdNET completes mid-session, adds new detections | Lane assignment recomputes; new detections inserted into lanes without shifting existing assignments (stable by id-sorted greedy fit). |
| Existing `f` shortcut cycles displayMaxHz | Lanes are in normalized 0–1 space; freq-range change doesn't break lane positions. |
| Popover anchor follows scroll/zoom | Anchor subscribes to scroll + zoom events; closes if box leaves viewport. |
| Compression / revert job running concurrently | Spectrogram is loaded from the file URL; concurrent jobs don't affect the loaded clip. |
| WAV vs FLAC | Already extension-agnostic per CLAUDE.md. |
| Mobile / tablet | `sm` viewport forces compacto height; zoom dropdown still works; modifier-wheel is desktop-only; pinch unsupported in v1. |

## Acceptance Criteria (Aggregated)

### Functional

- [ ] Compacto / Cómodo / Alto toggle works and persists.
- [ ] Zoom 1× / 2× / 4× / 8× works via dropdown, `Alt+=/-/0`, `Ctrl/Cmd+wheel`, and trackpad pinch.
- [ ] Mouse-wheel zoom anchors on cursor time.
- [ ] Frequency axis stays sticky; time axis stretches with body.
- [ ] Detection boxes (SVG) scale cleanly; labels reposition correctly.
- [ ] Card-click auto-scrolls to box center and pulses; respects `prefers-reduced-motion`.
- [ ] Playback cursor stays visible while `Seguir reproducción` is on; manual scroll temporarily pauses follow.
- [ ] Labels collapse to letter chips at low effective width; expand at high zoom; hover tooltip works.
- [ ] Overlapping detections render in lanes; non-overlapping render full-height; groups > 12 fall back to dense mode + console.warn.
- [ ] All UI strings in Spanish.

### Non-Functional

- [ ] Zoom transition < 100 ms on 60-s file with 50 detections.
- [ ] No layout regression at any height × zoom × sidebar-state combination.
- [ ] WCAG: collapsed chips include letter; reduced-motion respected; new keyboard shortcuts in help dialog.
- [ ] Settings persist across reload and migrate cleanly from v1.

### Quality Gates

- [ ] All new pure helpers in `src/lib/spectrogram-layout.ts` and `src/lib/spectrogram-settings.ts` have unit tests.
- [ ] No tests broken in existing suite (`npm run test:run`).
- [ ] `npm run lint` clean.
- [ ] `npm run build` succeeds.
- [ ] Manual screenshot checklist completed for each phase before merge.
- [ ] **LOC budget (per Kieran review):** `fft-spectrogram.tsx` net growth ≤ 150 lines after Phase 4 ships. If exceeded, more logic must move into `spectrogram-layout.ts`. The 1155-line baseline is already a smell; this plan should not make it worse.
- [ ] Discriminated-union exhaustiveness: every `switch` on `LaneAssignment.mode` and `StoredSettings.version` ends with a `default` branch that asserts `_exhaustive: never`.

## Testing Strategy

Given vitest runs in `node` (no jsdom) and there are no existing tests for `fft-spectrogram.tsx` or `annotation-client.tsx`, the regression surface is high. Mitigation:

1. **Extract pure logic** into `src/lib/spectrogram-layout.ts` and `src/lib/spectrogram-settings.ts` — testable in node env.
2. **Manual screenshot checklist** per phase (CLAUDE.md mandates testing in full context):
   - Each phase has its own checklist above (Phase 1: 3 heights × 2 audio states; Phase 2: 4 zooms × playback × card-click × resize; Phase 3: chip transition + tooltip; Phase 4: lane stacking on busy file).
3. **Playwright smoke test** (optional, follow-up): a single E2E that loads the annotate page, opens the dialog, toggles each control, and verifies no console errors. Could be added to `tests/e2e/` later.
4. **Sidebar-open layout regression** test by manual checklist — biochoco gotcha doc emphasizes this.

## Risks & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Canvas blur at 8× CSS-stretched | High | Medium | Document as v1 tradeoff; cap at 4× if user-testing shows it unusable. v2 path is FFT recompute. |
| Popover anchor desync at zoom | Medium | High (broken species-picker) | Centralize coord math in `src/lib/spectrogram-layout.ts`; subscribe popover to scroll/zoom; auto-close on out-of-viewport. |
| Lane assignment performance on huge detection sets | Low | Medium | Memoize; 12-lane cap; fallback dense mode. |
| Settings migration drops data | Low | Medium | Try/catch; preserve all known v1 fields; log on parse error. |
| Keyboard shortcut conflict with browser zoom | Low (Alt-modifier) | Medium | Use `Alt`, not bare `+/-`. Listed explicitly in help dialog. |
| Reduced-motion users see jarring scroll | Low | Low | Honor `prefers-reduced-motion: reduce` → instant scroll, no pulse. |
| Mobile/tablet behavior | Medium | Low | `sm` viewport forces compacto; pinch unsupported v1 (documented). |

## Rollout Plan

Ship phases sequentially, each behind no feature flag (low-risk client UI; revert-via-deploy is fast). Pause between phases for verifier-team feedback before starting the next.

- **Phase 1 (height toggle)** — smallest diff, ~150 LOC + 1 new module + 1 test file. Target: 1–2 days. Ship and gather feedback for 3–5 days.
- **Phase 2 (zoom + scroll)** — largest diff, ~600 LOC across 4 files + tests. Target: 4–6 days. Ship behind a careful screenshot/manual review pass. Gather feedback 1 week.
- **Phase 3 (smart labels)** — ~150 LOC + 1 test file. Target: 1 day. Ship.
- **Phase 4 (lane stacking)** — ~200 LOC + tests. Target: 2 days. Ship.

Each phase can be a separate PR / commit chain. If user feedback after Phase 1 or 2 says "this is enough," subsequent phases can be deferred without rework.

## Documentation Plan

- Update `Ayuda y atajos` dialog (existing modal triggered by `?` key) with the new shortcuts.
- Note the new settings in `CLAUDE.md` Audio module section ("Spectrogram height + zoom prefs in `audio.spectrogram.v2` localStorage").
- If user testing reveals quirks at 8×, add a `docs/solutions/ui-bugs/spectrogram-zoom-quality.md` note for future maintainers.

## References & Research

### Internal references

- Brainstorm: `docs/brainstorms/2026-05-13-audio-annotation-zoom-density-brainstorm.md`
- Existing spectrogram: `src/app/audio/[id]/annotate/[fileId]/fft-spectrogram.tsx:1–1155`
  - Constants: lines 25–28 (`FREQ_AXIS_WIDTH`, `TIME_AXIS_HEIGHT`, `SPEC_HEIGHT`)
  - Coord math: lines 564–576 (`timeToNX`, `hzToNY`, inverses)
  - SVG box overlay: lines 889–987
  - HTML label overlay: lines 992–1037
  - Playhead loop: lines 416–482
- Popover anchor (duplicated coord math): `src/app/audio/[id]/annotate/[fileId]/annotation-client.tsx:389–417`
- Settings + localStorage pattern: `src/app/audio/[id]/annotate/[fileId]/spectrogram-controls.tsx:6, 26–63`
  - Identical pattern in `src/app/camera-trap/deployments-table.tsx:116–142`
- Sticky-column pattern (transferable to freq-axis): `src/app/admin/admin-client.tsx:338`
- DetectionCardStrip auto-scroll pattern: `src/components/detection-card-strip.tsx:60–65, 122`
- Vitest config (no jsdom): `vitest.config.ts`
- CLAUDE.md UI Development section (layout regression mandate)

### Documented gotchas applied

- `docs/solutions/ui-bugs/biochoco-overview-horizontal-scroll-map-overlap.md` — `min-w-0` on every flex child in the chain; `overflow-y: hidden` explicitly alongside `overflow-x: auto`; test with sidebar open.
- `docs/solutions/runtime-errors/spectrogram-process-explosion-AudioCache-20260226.md` — not directly applicable here (this plan doesn't touch the audio cache), but reaffirms inflight-deduplication patterns we use elsewhere.

### Related prior work

- `docs/brainstorms/2026-05-10-audio-spectrogram-redesign-brainstorm.md` — earlier brainstorm; mostly orthogonal but informs the design language.
- `docs/brainstorms/2026-05-10-audio-annotation-ux-parity-brainstorm.md` — parity with camera-trap annotation UX.
- `docs/brainstorms/2026-02-25-audio-annotation-spectrogram-brainstorm.md` — original spectrogram brainstorm.

### Next steps after planning

Recommended: `/deepen-plan` to add even more grounding (running this plan was ultrathink'd already, so deepen is optional polish), then `/plan_review` from DHH/Kieran/Simplicity reviewers, then `/workflows:work` Phase 1.
