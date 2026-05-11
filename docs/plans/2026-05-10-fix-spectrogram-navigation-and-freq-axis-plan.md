---
title: Spectrogram navigation, freq axis, grayscale, and annotation QoL
type: fix
date: 2026-05-10
---

# Spectrogram navigation, freq axis, grayscale, and annotation QoL

## Overview

The new client-side FFT spectrogram component (`fft-spectrogram.tsx`, shipped on `feat/birdnet-audio-analysis`) regressed three navigation affordances that wavesurfer.js previously gave us "for free," and has a render bug where the frequency-axis canvas displays as a blank black strip. Add a Merlin-style grayscale colormap while we're in there, plus three quality-of-life polish items that compound during long annotation sessions.

This plan bundles four bug/feature fixes plus three QoL adds, all observed/proposed at `http://localhost:3003/audio/137/annotate/51`:

**Bug fixes & features**

1. **Y-axis (frequency) labels never appear** — the 70 px wide left-side strip is just the parent's `bg-zinc-950` showing through a blank canvas.
2. **Click on the spectrogram does not seek** — only the slim 24 px time axis underneath is clickable.
3. **Arrow keys jump files** instead of seeking ±5 s — the instinctive shortcut is unavailable.
4. **No B&W / Merlin-style colormap** — current four colormaps (viridis, magma, inferno, turbo) are all dark-bg / bright-energy.

**Quality-of-life adds**

5. **Box visual state by verification status** — verified / rejected / unverified are visually identical today; users have to read the sidebar.
6. **Loop selection (`l` key)** — verifying tricky IDs takes 3–4 plays; pressing `p` each time is friction.
7. **Jump to next unverified (`n` key)** — re-opening a partially-annotated file requires manually finding the next unverified box.

## Problem Statement / Motivation

Wavesurfer.js handled axis rendering, click-to-seek, and arrow seeking as built-in behavior. The migration to a custom React + canvas implementation was deliberate (see `docs/brainstorms/2026-05-10-audio-spectrogram-redesign-brainstorm.md`), but the navigation polish was implicitly dropped. For an annotation tool where users scrub thousands of times per session, this is a daily friction.

The freq-axis bug is a hard regression from the old implementation — labels are *required* to make sense of bounding-box frequency ranges. Until it's fixed, users cannot tell whether a box at 4 kHz vs 8 kHz contains the call they're looking for.

The grayscale colormap is small in scope but high in payoff: many ornithologists trained on Merlin / Raven / Audacity expect that visual style, and the absence of it breaks pattern recognition.

## Proposed Solution

Four small, independent fixes in a single PR. Each is local to one or two files; combined diff should be under ~150 lines.

### Issue 1 — Freq-axis labels not rendering

**Root cause:** The freq-axis `useEffect` runs once on mount (`fft-spectrogram.tsx:317-345`) with deps `[displayMaxHz]`. At that moment:

- `canvas.width` / `canvas.height` still hold their default `300 × 150` (the wrapper div is `70 × 256`).
- No `setTransform(dpr, …)` has been applied yet.
- The effect paints labels at logical CSS px coordinates, but the bitmap is the wrong size with identity transform → most labels land off-screen.

Then the `ResizeObserver` (`fft-spectrogram.tsx:377-393`) runs `apply()`, which calls `sizeCanvas(freqAxisRef.current, FREQ_AXIS_WIDTH, SPEC_HEIGHT)`. Writing to `canvas.width` / `canvas.height` clears the bitmap, then `setTransform` is applied. Result: a now-blank, correctly-sized, DPR-aware canvas — but the freq-axis effect never re-runs, so nothing redraws.

The parent's `bg-zinc-950` shows through the transparent canvas → "big black space to the left."

**Fix:** Make the freq-axis effect own its own sizing, identical to the time-axis pattern. Concretely:

- Add `specSize.height` to the dep array so the effect re-runs after the resize observer publishes a height (in practice it re-runs once on the first non-zero `specSize`, then never again unless `displayMaxHz` changes).
- Inside the effect, call `sizeCanvas(canvas, FREQ_AXIS_WIDTH, SPEC_HEIGHT)` *before* drawing — this both ensures the transform is fresh and acts as an idempotent no-op on subsequent runs because the dimensions are constants.
- Remove the `freqAxisRef` line from the resize observer since the effect now handles sizing.

Pseudocode for `fft-spectrogram.tsx:318-345`:

```ts
// before
useEffect(() => {
  const canvas = freqAxisRef.current;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, FREQ_AXIS_WIDTH, SPEC_HEIGHT);
  ctx.fillStyle = "#0a0a0a";
  // …labels…
}, [displayMaxHz]);

// after
useEffect(() => {
  const canvas = freqAxisRef.current;
  if (!canvas) return;
  sizeCanvas(canvas, FREQ_AXIS_WIDTH, SPEC_HEIGHT);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  // …same drawing code…
}, [displayMaxHz, specSize.height]);
```

And in `apply()` (line 381-388), drop:

```ts
if (freqAxisRef.current) sizeCanvas(freqAxisRef.current, FREQ_AXIS_WIDTH, SPEC_HEIGHT);
```

(or leave it as a belt-and-suspenders idempotent call; either is fine. Cleanest is to drop it.)

### Issue 2 — Click on the spectrogram does not seek

**Root cause:** `handleSvgPointerUp` at `fft-spectrogram.tsx:656-707` handles three drag kinds. For `drawing-new`, when the pointer never moved (`!drag.hasDragged`), the handler `return`s silently — a click is dropped.

**Fix:** Treat a no-drag pointerUp as a seek. The user clicked at a CSS x coordinate; convert to time and assign `audio.currentTime`. The playhead `rAF` loop already handles the visual update via the `seeked` listener.

Pseudocode for `fft-spectrogram.tsx:665-680`:

```ts
if (drag.kind === "drawing-new") {
  setPreviewRect(null);
  if (!drag.hasDragged) {
    // Click without drag → seek to that time
    const a = audioRef.current;
    if (a) a.currentTime = clamp(nxToTime(drag.startNX), 0, duration);
    return;
  }
  // …existing draw-complete logic…
}
```

This is intentionally additive — the rest of the draw-new branch stays identical. Box drawing still requires a drag past `DRAG_THRESHOLD_PX = 5`, so we don't accidentally create boxes from clicks.

**Edge case:** When `editable` is `false` (read-only viewer), `handleSvgPointerDown` (line 533) early-returns and never sets `dragRef.current = drawing-new`. So a click on a read-only spectrogram won't seek today. We should make seek work in read-only mode too. Adjust `handleSvgPointerDown` so the `editable` guard only protects the *drawing/resizing/moving* branches; allow a click → setPointerCapture for seek-on-up regardless. Cleanest: handle seek in a separate `onClick` on the SVG instead of going through the drag state machine. That's two lines and avoids the `editable` mess.

Decision: add a separate `handleSvgClick` that runs on `onClick`, and only seek if `dragRef.current.kind === "idle"` (i.e., it wasn't part of a drag that we already handled). React fires `onClick` after `pointerup` so the drag state will already be reset. This is simpler than threading state through the existing handler.

```ts
const handleSvgClick = useCallback(
  (e: React.MouseEvent<SVGSVGElement>) => {
    // ignore clicks that landed on a box or handle (those handle their own logic)
    const target = e.target as SVGElement;
    if (target.closest("[data-box-id]") || target.closest("[data-handle]")) return;
    const { nx } = eventToNorm(e.clientX, e.clientY);
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = clamp(nxToTime(nx), 0, duration);
  },
  [eventToNorm, nxToTime, duration]
);
```

Wire it on the SVG: `onClick={handleSvgClick}`. Drag-to-draw still fires on pointermove and pointerup so the click that follows a drag would re-seek to the up-position. To avoid that, suppress the click after a real drag: track a `suppressNextClickRef = useRef(false)` set to `true` in pointerUp when `drag.hasDragged`. In `handleSvgClick`, consume and clear it.

Net effect: bare click anywhere → seek; drag → draw a box; click on existing box → select; drag a box → move; drag a handle → resize. All four still work.

### Issue 3 — Arrow keys hijacked by file nav

**Root cause:** `src/hooks/use-audio-annotation-shortcuts.ts:127-134` binds plain `ArrowLeft` → `onPrev`, `ArrowRight` → `onNext`. Q/E and [/] are wired to seek but invisible to muscle memory.

**Fix:** Re-bind:

- `ArrowLeft` (no modifier) → `onSeekBack` (5 s back)
- `ArrowRight` (no modifier) → `onSeekForward` (5 s forward)
- `Shift+ArrowLeft` → `onPrev` (file nav)
- `Shift+ArrowRight` → `onNext` (file nav)

Pseudocode for `use-audio-annotation-shortcuts.ts:127-134`:

```ts
case "ArrowLeft":
  e.preventDefault();
  if (e.shiftKey) o.onPrev?.();
  else o.onSeekBack?.();
  break;
case "ArrowRight":
  e.preventDefault();
  if (e.shiftKey) o.onNext?.();
  else o.onSeekForward?.();
  break;
```

Note `hasModifier` (line 97) was previously `e.metaKey || e.ctrlKey || e.altKey` — *not* `shiftKey`. So shift was already not blocking other keys. Good — no broader changes needed.

Update `AUDIO_SHORTCUTS` Spanish help array in the same file:

```diff
- { key: "←/→", description: "Archivo anterior/siguiente", category: "navigation" },
+ { key: "←/→", description: "Retroceder/avanzar 5s", category: "playback" },
+ { key: "Shift + ←/→", description: "Archivo anterior/siguiente", category: "navigation" },
```

Also drop the now-redundant `Q/E o [ / ]` entry to reduce visual clutter — those still work as undocumented aliases. Actually — keep them documented but lower priority, since some users may already use them. Final help array order shown in the plan's Acceptance Criteria.

### Issue 4 — Add Merlin-style grayscale colormap

**Decision:** Add `"grayscale"` colormap. White background → black for high energy (Merlin's aesthetic). This is *inverted* relative to the existing four (which all go from dark for silence to bright for energy).

Update `src/lib/spectrogram-colormaps.ts`:

```ts
export type ColormapName = "viridis" | "magma" | "inferno" | "turbo" | "grayscale";

function buildGrayscale(): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const v = 255 - i; // invert: low energy → white, high → black
    lut[i * 3] = v;
    lut[i * 3 + 1] = v;
    lut[i * 3 + 2] = v;
  }
  return lut;
}

export const COLORMAPS: Record<ColormapName, Uint8ClampedArray> = {
  viridis: buildFromAnchors(VIRIDIS_ANCHORS),
  magma: buildFromAnchors(MAGMA_ANCHORS),
  inferno: buildFromAnchors(INFERNO_ANCHORS),
  turbo: buildTurbo(),
  grayscale: buildGrayscale(),
};

export const COLORMAP_NAMES: readonly ColormapName[] = [
  "viridis", "magma", "inferno", "turbo", "grayscale",
];
```

Existing tests in `tests/unit/lib/spectrogram-colormaps.test.ts` enumerate `COLORMAP_NAMES` to assert each LUT is 256×3 with distinct first/last entries. They will pass for grayscale automatically (`[255,255,255]` ≠ `[0,0,0]`), no test changes required.

`spectrogram-controls.tsx` uses `COLORMAP_NAMES.map(...)` to render dropdown options and validates stored values against the same array, so the new colormap appears in the dropdown and is settable from localStorage with no further changes. The `loadStoredSettings` validation `parsed.colormap && COLORMAP_NAMES.includes(parsed.colormap)` continues to work.

**Visual check needed (manual):** The species color box stroke (`getSpeciesColor()`, e.g. `#22c55e` green) should remain visible against a near-white background. If contrast is poor, we'd add a darker outer halo to box strokes when colormap is grayscale — but this is unlikely; species colors are mid-saturation and remain visible on white. Defer outline halo as v2 polish.

### Issue 5 — Box visual state by verification status

**Problem:** `AudioBoxData` already carries `verificationStatus: "unverified" | "verified" | "rejected"`, but `fft-spectrogram.tsx` only varies stroke / fill opacity by *selection* (`isSelected`) and *legacy-full* (full-frequency-range fallback boxes). Verified and rejected boxes look identical to unverified ones. Users have to read the sidebar to see file progress.

**Fix:** Modulate `fillOpacity` / `strokeOpacity` by `verificationStatus` *in addition to* the existing selection / legacy logic. No new colors — uses opacity to convey state, so it composes cleanly with species colors and any colormap (including the new grayscale).

Modify the per-box render in `fft-spectrogram.tsx:817-853`:

```ts
const status = box.verificationStatus ?? "unverified";
const isVerified = status === "verified";
const isRejected = status === "rejected";

// Existing isSelected / isLegacyFull / color computations stay the same.

const fillOpacity = isSelected
  ? 0.30
  : isRejected
  ? 0.05
  : isVerified
  ? 0.28      // slightly more "filled-in" than unverified
  : isLegacyFull
  ? 0.10
  : 0.15;

const strokeOpacity = isRejected
  ? 0.35      // faded
  : isLegacyFull && !isSelected
  ? 0.6
  : 1;

// Optional: a subtle ✓ glyph in the corner for verified boxes — defer; opacity alone is enough.
```

Net visual effect:
- **Unverified** (default): unchanged from today.
- **Verified**: noticeably more filled-in (0.28 vs 0.15 fill), strong stroke. Reads as "settled."
- **Rejected**: faded out (0.05 fill, 0.35 stroke). Reads as "ignored / archived."
- **Selected**: still pops over everything else (0.30 fill).

### Issue 6 — Loop selection (`l` key)

**Problem:** Verifying borderline IDs requires repeated playback. Current `playSelection(start, end)` (existing on `SpectrogramMethods`) plays once and stops. Users press `p` repeatedly.

**Fix:** Add a `loop` mode to the selection-end mechanism. When loop is on and playback hits `selectionEndRef`, jump back to `selectionStartRef` instead of pausing. Toggle with `l` key on the selected box. Stops automatically on: another `l`, spacebar pause, manual seek (click), changing selection, file change.

Implementation in `fft-spectrogram.tsx`:

1. Add refs alongside `selectionEndRef`:
   ```ts
   const selectionStartRef = useRef<number | null>(null);
   const loopRef = useRef(false);
   ```

2. Extend the `tick` rAF loop (currently lines 400–414):
   ```ts
   if (selectionEndRef.current !== null && t >= selectionEndRef.current) {
     if (loopRef.current && selectionStartRef.current !== null) {
       a.currentTime = selectionStartRef.current;
     } else {
       a.pause();
       selectionEndRef.current = null;
     }
   }
   ```

3. Extend `playSelection` to also set `selectionStartRef.current = startTime` (not just end).

4. Add to `SpectrogramMethods`:
   ```ts
   loopSelection: (startTime: number, endTime: number) => Promise<void>;
   stopLoop: () => void;
   isLooping: () => boolean;
   ```

5. Implement `loopSelection`: same as `playSelection` but sets `loopRef.current = true`.

6. Wire shortcut in `use-audio-annotation-shortcuts.ts`:
   - Add `onToggleLoop?: () => void` option.
   - Add `case "l"` in the switch with `e.preventDefault()` + `o.onToggleLoop?.()`.
   - Append `{ key: "l", description: "Reproducir en bucle la detección seleccionada", category: "playback" }` to `AUDIO_SHORTCUTS`.

7. In `annotation-client.tsx`, implement `onToggleLoop`:
   ```ts
   onToggleLoop: () => {
     const sel = selectedDetection;
     if (!sel) return;
     if (spectrogramRef.current?.isLooping?.()) {
       spectrogramRef.current.stopLoop();
     } else {
       spectrogramRef.current?.loopSelection(sel.startTime, sel.endTime);
     }
   },
   ```

8. Auto-stop loop on: `playPause` toggle, `seek`, `skip`, click-to-seek (Issue 2 handler) — all need to call `loopRef.current = false; selectionEndRef.current = null` at entry.

**Edge case:** If the selected box ends at audio duration, the loop wrap-around hits the end before `selectionEndRef` triggers. Mitigation: clamp `selectionEndRef` to `min(endTime, duration - 0.05)` on set.

### Issue 7 — Jump to next unverified (`n` key)

**Problem:** When re-opening a partially-annotated file, the user has to scan visually to find the next unverified box. The existing `selectedDetectionId` state has no "next" affordance.

**Fix:** Add an `n`-key shortcut that finds the next detection (in `startTime` order) whose identification is unverified, then selects + seeks to it. Wraps around to the start of the file. If none unverified, brief toast "Todas verificadas en este archivo."

Implementation:

1. In `annotation-client.tsx`, add `onJumpToNextUnverified` handler:
   ```ts
   onJumpToNextUnverified: () => {
     const sorted = [...detections].sort((a, b) => a.startTime - b.startTime);
     const currentIdx = selectedDetectionId
       ? sorted.findIndex((d) => d.id === selectedDetectionId)
       : -1;
     // Search forward from currentIdx + 1, then wrap.
     for (let offset = 1; offset <= sorted.length; offset++) {
       const i = (currentIdx + offset + sorted.length) % sorted.length;
       if (sorted[i].identification?.verificationStatus === "unverified") {
         setSelectedDetectionId(sorted[i].id);
         spectrogramRef.current?.seek(sorted[i].startTime);
         return;
       }
     }
     toast({ title: "Todas verificadas en este archivo" });
   },
   ```

2. Wire shortcut in `use-audio-annotation-shortcuts.ts`:
   - Add `onJumpToNextUnverified?: () => void` option.
   - Add `case "n"` in the switch with `e.preventDefault()` + `o.onJumpToNextUnverified?.()`.
   - Append `{ key: "n", description: "Saltar a la siguiente sin verificar", category: "navigation" }` to `AUDIO_SHORTCUTS`.

**Edge case:** When all unverified detections are *after* the current selection, wrap-around still finds them on the second pass. When *all* are verified or rejected, the toast fires. Confirmed by the modulo loop shape.

## Technical Considerations

- **No server changes** — entirely client-side; no migrations, no API changes, no auth changes.
- **No new dependencies** — uses existing `fft.js`, no additional packages.
- **localStorage compatibility** — the existing migration in `loadStoredSettings()` already validates against `COLORMAP_NAMES`, so users with stored `"magma"` etc. continue to work; users with corrupt entries fall back to defaults.
- **DPR safety** — fixing the freq-axis effect to own its own sizing means the effect is correct on first paint, on resize, and on devicePixelRatio changes (e.g., dragging between retina and external monitor — though the resize observer would also need to fire for full DPR migration, which is a separate concern not covered here).
- **Box-drawing UX preserved** — click-to-seek piggybacks on `onClick`; drag-to-draw is unaffected because we suppress the synthetic click after any real drag via `suppressNextClickRef`.
- **Read-only viewers can now seek** — moving seek out of the editable-only drag handler fixes a usability gap for non-editor roles (visor permission).

## Acceptance Criteria

### Functional

- [ ] Y-axis frequency labels render on first paint at `/audio/137/annotate/51`. Labels show `0 Hz`, `2 kHz`, …, up to `displayMaxHz`. Verified at multiple `displayMaxHz` settings (3 / 6 / 9 / 12 kHz, plus Nyquist).
- [ ] Y-axis labels survive a window resize (resize observer triggers re-render).
- [ ] Y-axis labels survive a `displayMaxHz` change (cycling with `f` key updates ticks).
- [ ] Clicking anywhere on the spectrogram (not on a box, not on a handle) seeks audio to that time. Playhead jumps; current time updates.
- [ ] Click while paused → seek without auto-play. Click while playing → seek and continue playing (browser default behavior).
- [ ] Click on an existing box → still selects the box (no seek).
- [ ] Drag-to-draw a new box → still works; the trailing click does *not* seek to the drag end.
- [ ] `ArrowLeft` (no modifier) → seek −5 s. Edge: at start of file, clamps to 0.
- [ ] `ArrowRight` (no modifier) → seek +5 s. Edge: past end, clamps to duration.
- [ ] `Shift+ArrowLeft` → previous file. `Shift+ArrowRight` → next file.
- [ ] `Q`, `[`, `E`, `]` continue to work as redundant seek aliases.
- [ ] `grayscale` appears in the colormap dropdown and renders a white-to-black image.
- [ ] Cycling colormaps with `m` includes `grayscale` in the rotation.
- [ ] Existing localStorage entries for the four old colormaps still round-trip.
- [ ] Box species-color strokes remain visible on grayscale (visual check).
- [ ] Verified boxes appear visibly more "filled-in" than unverified ones (0.28 vs 0.15 fill opacity).
- [ ] Rejected boxes appear faded (0.35 stroke, 0.05 fill).
- [ ] Selecting a verified or rejected box still highlights it strongly (selection wins over status styling).
- [ ] `l` key on a selected box toggles loop playback. Visual indicator (spec or sidebar) shows loop is active.
- [ ] Pressing `l` again, spacebar, click-to-seek, or selecting a different box stops the loop.
- [ ] `n` key jumps to next unverified detection in time order, wraps around, selects it, and seeks playhead.
- [ ] When no unverified detections remain, `n` shows a Spanish toast (no error, no crash).

### Non-functional

- [ ] Lint passes (`npm run lint` clean for touched files).
- [ ] Type-check passes (`npx tsc --noEmit` exits 0).
- [ ] Unit tests pass (`npm run test:run`) — no new failures, including the existing colormap test (will verify new entry passes the distinct-endpoints assertion automatically).
- [ ] No console errors in browser when interacting with all four affected behaviors at `/audio/137/annotate/51`.

### Help / discoverability

- [ ] `AUDIO_SHORTCUTS` array updated with arrow-key seek line and Shift+arrow file-nav line.
- [ ] Keyboard help modal (if shown anywhere on the page) reflects new bindings.

## Success Metrics

- Annotation throughput stops being bottlenecked by "I can't tell what frequency this box is at" — qualitative, validated by 1 self-test session annotating ≥10 boxes on a real recording.
- No bug reports about "can't navigate the audio" within 1 week of merge (no formal tracking; relying on direct feedback).

## Dependencies & Risks

**Dependencies:** none — all four fixes are local edits to existing files.

**Risks:**

- **Click-to-seek false positives.** If `suppressNextClickRef` logic is buggy, drag-to-draw might also seek. Mitigation: test drawing 5+ boxes manually and verify playhead doesn't jump to the drag end.
- **Arrow-key collision with browser/OS shortcuts.** Plain ArrowLeft/Right inside form fields is filtered already (`isInEditableField` check at `use-audio-annotation-shortcuts.ts:76-83`). No new collisions expected, but the species search input bypasses this — verify focus on search input still doesn't trigger seek.
- **DPR transform after sizeCanvas.** Moving sizing into the effect must reset transform — `sizeCanvas()` already does this via `setTransform(dpr, …)`. No additional risk.
- **Grayscale + species color contrast** — green / blue species strokes may feel washed-out on a very-light background. Acceptable for v1; can add stroke-halo follow-up if a user complains.

## Files Touched

| File | Change |
|---|---|
| `src/app/audio/[id]/annotate/[fileId]/fft-spectrogram.tsx` | Freq-axis effect owns sizing; new `handleSvgClick` for seek; `suppressNextClickRef`; verified/rejected fill+stroke opacity; loop refs + `loopSelection`/`stopLoop`/`isLooping` on `SpectrogramMethods`; rAF wrap-around |
| `src/hooks/use-audio-annotation-shortcuts.ts` | Re-bind ArrowLeft/Right with shift modifier; new `l` and `n` cases; `onToggleLoop` and `onJumpToNextUnverified` options; update `AUDIO_SHORTCUTS` help array |
| `src/lib/spectrogram-colormaps.ts` | Add `"grayscale"` to `ColormapName`, `COLORMAPS`, `COLORMAP_NAMES`; new `buildGrayscale()` |
| `src/app/audio/[id]/annotate/[fileId]/annotation-client.tsx` | Wire `onToggleLoop` and `onJumpToNextUnverified`; auto-stop loop on play/seek/file-change |

No changes needed in `spectrogram-controls.tsx`, `audio-fft.ts`, or any test files (existing colormap test passes on the new entry).

## Implementation Phases

### Phase 1 — Freq-axis fix (~10 LOC)

1. In `fft-spectrogram.tsx:318-345`, prepend `sizeCanvas(canvas, FREQ_AXIS_WIDTH, SPEC_HEIGHT);` after the null guards.
2. Change deps to `[displayMaxHz, specSize.height]`.
3. Drop the `if (freqAxisRef.current) sizeCanvas(...)` line from `apply()` in the resize observer.
4. Manual verify: y-axis labels render on `/audio/137/annotate/51`.

### Phase 2 — Click-to-seek (~15 LOC)

1. Add `suppressNextClickRef = useRef(false)` near the other refs.
2. Set `suppressNextClickRef.current = true` in `handleSvgPointerUp` when any drag had `hasDragged === true` (drawing-new with hasDragged, moving with hasDragged, or any resizing).
3. Add `handleSvgClick` callback that bails on box/handle hits, consumes and clears `suppressNextClickRef`, otherwise seeks to `nxToTime(nx)`.
4. Wire `onClick={handleSvgClick}` on the SVG element (line 805-816).
5. Manual verify: click empty space → seek; click on box → select; drag-to-draw → no seek artifact.

### Phase 3 — Arrow keys (~10 LOC)

1. In `use-audio-annotation-shortcuts.ts:127-134`, branch on `e.shiftKey`.
2. Update `AUDIO_SHORTCUTS` array entries for `←/→` and add `Shift + ←/→`.
3. Manual verify: arrows seek; Shift+arrows navigate files.

### Phase 4 — Grayscale colormap (~15 LOC)

1. In `src/lib/spectrogram-colormaps.ts`, extend `ColormapName`, add `buildGrayscale()`, add to `COLORMAPS` map and `COLORMAP_NAMES` array.
2. Manual verify: grayscale appears in dropdown; cycling with `m` includes it; spectrogram renders white-to-black.
3. Run `npm run test:run` — existing colormap tests should pass with no edits.

### Phase 5 — Box visual state by verification status (~10 LOC)

1. In `fft-spectrogram.tsx:817-853`, derive `isVerified` / `isRejected` from `box.verificationStatus` and adjust `fillOpacity` / `strokeOpacity` per the table in Issue 5.
2. Manual verify: open a file with a mix of unverified, verified, and rejected detections; visually confirm the three states are distinguishable at a glance without selecting any box.

### Phase 6 — Loop selection (~25 LOC)

1. Add `selectionStartRef` and `loopRef` next to `selectionEndRef` in `fft-spectrogram.tsx`.
2. Extend the `tick` rAF to wrap around to `selectionStartRef.current` when `loopRef.current === true`.
3. Add `loopSelection` / `stopLoop` / `isLooping` to `SpectrogramMethods` and `useImperativeHandle`.
4. Modify `play`, `seek`, `skip`, `playSelection`, and `handleSvgClick` to clear `loopRef` and `selectionEndRef` on entry (loop should not survive a manual seek).
5. Add `onToggleLoop` option + `case "l"` in `use-audio-annotation-shortcuts.ts`. Update `AUDIO_SHORTCUTS`.
6. In `annotation-client.tsx`, wire `onToggleLoop` to start/stop based on `spectrogramRef.current?.isLooping?.()`.
7. Manual verify: select a box, press `l`, audio loops indefinitely. Press `l` again → stops. Press space → stops. Click elsewhere → stops.

### Phase 7 — Jump to next unverified (~25 LOC)

1. In `annotation-client.tsx`, implement `onJumpToNextUnverified` per Issue 7 pseudocode (sort detections by startTime, modulo-walk forward from current selection, find next unverified, fall through to toast).
2. Add `onJumpToNextUnverified` option + `case "n"` in `use-audio-annotation-shortcuts.ts`. Update `AUDIO_SHORTCUTS`.
3. Manual verify: open a partially-annotated file; press `n` repeatedly; each press selects + seeks to the next unverified box; after the last one, wraps to the first; if all verified, toast appears.

### Phase 8 — Verification

1. `npx tsc --noEmit` — clean.
2. `npm run lint` — clean for touched files.
3. `npm run test:run` — same baseline, no new failures.
4. Manual smoke test at `/audio/137/annotate/51`:
   - All acceptance criteria above (functional + non-functional + help/discoverability).
   - Test in Chrome (primary) + Safari if convenient.
   - Spend ~5 min annotating a real file end-to-end to confirm the QoL adds genuinely improve the flow.

## References & Research

### Internal references

- Component being fixed: `src/app/audio/[id]/annotate/[fileId]/fft-spectrogram.tsx`
- Shortcut wiring: `src/app/audio/[id]/annotate/[fileId]/annotation-client.tsx:332-353` (`onSeekBack`/`onSeekForward` already correctly bound to `spectrogramRef.current?.skip(±5)`)
- Settings persistence + cycling: `src/app/audio/[id]/annotate/[fileId]/spectrogram-controls.tsx:162-172` (`cycleYMax`, `cycleColormap` — pure functions, no edits needed)
- Colormap LUTs: `src/lib/spectrogram-colormaps.ts`
- Existing brainstorm: `docs/brainstorms/2026-05-10-audio-spectrogram-redesign-brainstorm.md`

### CLAUDE.md conventions applied

- Spanish UI strings (`AUDIO_SHORTCUTS` already in Spanish)
- `requirePermission` is *not* needed here — all changes are client-side; no server actions touched
- No DB changes, no migrations
- Test policy: existing tests cover the boundary (LUT shape, decode/render purity); manual smoke test covers UI behavior

### External references

None — all fixes derive from reading project source. No external library quirks to research.
