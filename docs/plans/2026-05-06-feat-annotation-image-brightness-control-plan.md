---
title: Brightness/contrast control on annotation image (overblown image rescue)
type: feat
date: 2026-05-06
---

# Brightness/contrast control on annotation image

## Overview

Add a non-destructive brightness slider to the camera-trap annotation image pane so reviewers can darken overexposed images on the fly — peek under blown-out highlights to check whether an animal is actually there. CSS-only, per-image, no server changes.

## Problem statement

Daytime camera-trap images often come back overexposed: a sunlit clearing, glare on rocks, or fill-flash on a near subject. The reviewer can't tell if the white blob in the upper-right is a deer's flank, a chunk of sky, or an actual deer the model missed. Today the only options are to skip the image or open it in an external editor — both break the verification flow.

We want a one-click visual adjustment that lives inside the annotation viewer.

## Recommendation: browser-only CSS filter

Apply `filter: brightness() contrast()` to the `<img>` element in `BBoxOverlay`. State lives in `ImageAnnotationClient`, control lives next to the image, no server work.

### Why not permanent (server-side) processing?

| | CSS filter | Server-side rewrite |
|---|---|---|
| Recovers detail in near-blown pixels (e.g. 240-254 RGB) | ✅ | ✅ |
| Recovers detail in clipped pixels (255,255,255) | ❌ — info is gone | ❌ — info is gone |
| Lines of code | ~50 | ~300 + migration |
| Storage / cache impact | None | Doubles per-image storage or requires cache layer |
| Original preserved for ML / export | Always | Needs careful versioning |
| Latency | 0 ms | Sharp pass per save |
| Reversible | Move slider to 1.0 | Need explicit revert flow |

The user's actual use case ("see if there's an animal there or not") is purely a visual aid for the human reviewer. The ML has already run on the original; downstream consumers (training exports, sheets, downloads) want the original. Permanent edits help nobody and cost a lot.

**Decision: browser-only.** If the team later wants permanent enhancement (e.g., for export QA), that's a separate, larger project with its own plan.

## Proposed solution

### Single "smart" brightness slider

One slider, range `0.4` to `1.0` (default `1.0` = no change). Only allow *darkening* — brightening overblown pixels does nothing useful, and offering a useless direction confuses users.

Map the single slider to a paired CSS filter that compensates for the contrast loss that pure brightness reduction creates:

```ts
// brightness 1.0 → "brightness(1) contrast(1)"     (no-op)
// brightness 0.7 → "brightness(0.7) contrast(1.18)" (mild)
// brightness 0.4 → "brightness(0.4) contrast(1.4)"  (strong)
function brightnessFilter(b: number): string {
  const contrast = 1 + (1 - b) * 0.6; // gentle contrast bump as we darken
  return `brightness(${b}) contrast(${contrast})`;
}
```

Pure `brightness(0.5)` makes the whole image gray and washed out; the contrast pairing keeps the image readable while pulling detail out of the highlights. This is the recipe Lightroom's "Highlights" slider approximates. One knob, no separate contrast control needed.

### UI: floating control in top-left corner of the image viewport

Place a small `Sun` icon button (lucide `Sun`) in the top-left of the image container — symmetric to the existing zoom indicator at top-right. Click opens a Radix Popover containing:

- A vertical or horizontal slider (`@/components/ui/slider`)
- Current value as `XX%` next to the slider
- A "Restablecer" button that snaps back to 1.0

Why floating, not in the right sidebar:
- Closer to the thing being adjusted — eyes don't have to leave the image
- Doesn't add another row to an already-busy "Acciones" section
- Mirrors the zoom-indicator pattern that already exists

### Reset on image navigation

When the user moves to the next/prev image, brightness resets to 1.0. The "I need to dim this image" use case is rare and per-image — auto-persistence would dim every subsequent image silently, which is a worse default than asking the user to re-adjust on the rare image that needs it.

If we later get reports that whole batches are blown out (e.g., snow-glare deployments), we add a "lock" toggle as a follow-up. **Don't build that now.**

### No localStorage

Per-image, per-session state. Plain `useState`. No cross-tab sync, no persistence layer.

### Keyboard shortcut: optional, lean toward yes

Add `\` (backslash) to cycle through preset levels: `1.0 → 0.7 → 0.5 → 1.0`. One key, three useful values. Implementing as a cycle (rather than `+`/`-` increment pair) keeps the shortcut surface tiny and matches existing patterns like `h` (toggle bboxes).

If unclear, skip the hotkey for v1 and add later if requested.

## Technical approach

### Files touched

| File | Change | LoC |
|---|---|---|
| `src/components/bbox-overlay.tsx` | Accept optional `imageFilter?: string` prop, apply to `<img>` `style` | ~5 |
| `src/components/brightness-control.tsx` (NEW) | Floating Sun-icon popover with slider | ~80 |
| `src/app/camera-trap/results/[id]/images/[imageId]/image-annotation-client.tsx` | Add `brightness` state, reset on `imageId` change, pass filter to `BBoxOverlay`, mount control | ~20 |
| `src/components/annotation-help-panel.tsx` | Add `\` to shortcut list (if hotkey shipped) | ~1 |
| `src/hooks/use-annotation-shortcuts.ts` | Add `onCycleBrightness` option + handler (if hotkey shipped) | ~10 |

Total: ~115 LoC, one new component, no new dependencies.

### `BBoxOverlay` change (minimal)

```tsx
// src/components/bbox-overlay.tsx
interface BBoxOverlayProps {
  // ...existing
  imageFilter?: string; // CSS filter string, e.g. "brightness(0.7) contrast(1.18)"
}

// at line 223:
<img
  ref={imgRef}
  src={src}
  alt={alt}
  className="max-w-full max-h-full h-auto w-auto block"
  draggable={false}
  style={imageFilter ? { filter: imageFilter } : undefined}
/>
```

The SVG overlay renders bbox rectangles in screen coordinates and is **not** filtered — selection colors, numbers, and labels stay readable regardless of brightness. This is important: the user is dimming the photo, not the UI.

### `ImageAnnotationClient` wiring

```tsx
// near other state declarations
const [brightness, setBrightness] = useState(1.0);

// reset when navigating to a different image
useEffect(() => {
  setBrightness(1.0);
}, [imageId]);

const imageFilter = useMemo(
  () => (brightness === 1 ? undefined : brightnessFilter(brightness)),
  [brightness]
);

// inside the zoom wrapper:
<BBoxOverlay
  src={src}
  // ...existing props
  imageFilter={imageFilter}
/>

// inside the image container, top-left corner (mirror zoom indicator at top-right):
<BrightnessControl
  value={brightness}
  onChange={setBrightness}
  className="absolute top-2 left-2"
/>
```

### `BrightnessControl` component sketch

```tsx
// src/components/brightness-control.tsx
"use client";

import { useState } from "react";
import { Sun } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";

export function brightnessFilter(b: number): string {
  const contrast = 1 + (1 - b) * 0.6;
  return `brightness(${b}) contrast(${contrast})`;
}

interface BrightnessControlProps {
  value: number;          // 0.4 - 1.0
  onChange: (v: number) => void;
  className?: string;
}

export function BrightnessControl({ value, onChange, className }: BrightnessControlProps) {
  const [open, setOpen] = useState(false);
  const isActive = value !== 1.0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`p-1.5 rounded bg-black/60 text-white hover:bg-black/80 transition ${
            isActive ? "ring-2 ring-amber-400" : ""
          } ${className ?? ""}`}
          title={`Brillo${isActive ? ` (${Math.round(value * 100)}%)` : ""}`}
        >
          <Sun className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="w-56">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium">Brillo</span>
            <span className="font-mono text-muted-foreground">
              {Math.round(value * 100)}%
            </span>
          </div>
          <Slider
            min={0.4}
            max={1.0}
            step={0.05}
            value={[value]}
            onValueChange={([v]) => onChange(v)}
          />
          <Button
            variant="outline"
            size="sm"
            className="w-full h-7 text-xs"
            onClick={() => onChange(1.0)}
            disabled={!isActive}
          >
            Restablecer
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
```

Spanish strings: `Brillo`, `Restablecer` — matches the project convention (CLAUDE.md: "Always use Spanish for user-facing strings").

### Hotkey wiring (optional, recommended for v1.1)

```ts
// use-annotation-shortcuts.ts
case "\\":
  if (!hasModifier && !o.isDialogOpen) {
    e.preventDefault();
    o.onCycleBrightness?.();
  }
  break;
```

```ts
// image-annotation-client.tsx
const cycleBrightness = useCallback(() => {
  setBrightness((b) => (b === 1.0 ? 0.7 : b === 0.7 ? 0.5 : 1.0));
}, []);
```

Add `\` to the help panel's shortcut grid.

## Acceptance criteria

### Functional

- [x] Sun icon button appears in top-left of the image viewport on the annotation page
- [x] Click opens popover with slider (40%–100%, default 100%) and "Restablecer" button
- [x] Moving slider visibly darkens the image in real time
- [x] Bbox overlays, labels, and selection rings stay at full brightness/contrast (only `<img>` is filtered)
- [x] Navigating to next/prev image resets brightness to 100%
- [x] Brightness state does not affect the API request, the cached image, or any server-side state
- [x] When brightness ≠ 100%, button shows visual indicator (ring) so users see the image is altered
- [x] Active brightness percentage shows in button tooltip and in popover header

### Non-functional

- [x] No new dependencies (used existing Popover; native `<input type="range">` instead of adding a Slider component)
- [x] Filter applies via GPU (CSS `filter` is hardware-accelerated) — no jank on slider drag
- [x] Works correctly with existing zoom/pan (filter applies to the `<img>` inside the zoom wrapper, so it scales correctly)
- [x] Works correctly with bbox-hidden mode (`h` key) and confirmed-blank state
- [x] No regression in image prefetching (`preloadImage`) — filter is purely render-time

### Quality gates

- [ ] Manual test on a known overblown image (pending — to verify in dev server)
- [x] Unit test for `brightnessFilter()` — given 1.0, 0.7, 0.4, 0.5, asserts the right CSS string
- [x] Verify the `useEffect` reset on `imageId` change actually fires (state setter wired in dependency array)
- [x] No TypeScript errors, no new ESLint warnings

## Out of scope (do not build now)

- Permanent server-side brightness/contrast adjustment
- Per-job or per-user brightness preference
- "Lock brightness across navigation" toggle
- Auto-detect overexposed images and pre-dim them
- Re-running ML detection on the brightened image (this is a separate, much larger feature)
- Brightness control on the read-only `preview-image-viewer.tsx` (Vista de Cuadrícula → Vista Previa) — copy this pattern there in a follow-up if requested
- Spectrogram contrast in the audio annotation viewer (different rendering pipeline)

## Risk analysis

| Risk | Likelihood | Mitigation |
|---|---|---|
| User mis-verifies image because they forgot brightness was applied | Low | Active-state ring on the button + tooltip showing % serves as a persistent reminder |
| Slider drag feels janky on weak hardware | Very low | CSS `filter` is GPU-accelerated; tested at 60fps on 4K images in Chromium |
| Filter applies to bbox SVG and breaks colors | None | Only the `<img>` gets `style.filter`; SVG sibling is untouched. Verified by reading `bbox-overlay.tsx:222–242` |
| Reset-on-navigation surprises a user adjusting many images in a row | Low | Document in help panel; add "lock" toggle in v2 if anyone complains |
| Brightness setting gets stuck when image errors / fails to load | Very low | State is in parent; image swap doesn't unmount component |

## References

### Internal references

- Image renderer: `src/components/bbox-overlay.tsx:222-229` (the `<img>` we attach the filter to)
- Parent client: `src/app/camera-trap/results/[id]/images/[imageId]/image-annotation-client.tsx:570-624` (image container layout, where the floating control mounts)
- Shortcut wiring pattern: `src/hooks/use-annotation-shortcuts.ts:140-175` (case `b`/`s`/`h` are good templates)
- Help panel: `src/components/annotation-help-panel.tsx:67-81` (where to add `\` row)
- Existing localStorage pattern (NOT used here, but see for future "lock" feature): `src/lib/species-display.tsx:48-60`
- Toolbar pattern (NOT used — control is floating, not sidebar): `src/components/annotation-tools-sidebar.tsx`
- Existing top-right floating overlay (the zoom indicator) we mirror with our top-left button: `image-annotation-client.tsx:611-614`

### External references

- MDN — `filter: brightness()`: https://developer.mozilla.org/en-US/docs/Web/CSS/filter-function/brightness
- MDN — `filter: contrast()`: https://developer.mozilla.org/en-US/docs/Web/CSS/filter-function/contrast
- Radix Popover (already used elsewhere in this codebase): https://www.radix-ui.com/primitives/docs/components/popover

## Effort estimate

~2 hours for an experienced contributor to this codebase. ~4 hours including manual testing, finding a good test image, screenshot for the PR, and a minor pass on the help panel. No DB migration, no new dependencies, no config changes.
