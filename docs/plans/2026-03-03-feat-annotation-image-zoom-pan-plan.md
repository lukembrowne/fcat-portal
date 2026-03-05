---
title: Annotation Image Zoom & Pan
type: feat
date: 2026-03-03
---

# Annotation Image Zoom & Pan

## Overview

Add scroll-wheel zoom and Space+drag pan to the camera trap annotation page. Allows users to inspect fine details of camera trap images without leaving the annotation workflow.

## Problem Statement

Camera trap images are often high-resolution (4000x3000+) but displayed fit-to-container on the annotation page. Small or distant animals can be hard to identify at this scale. Currently there's no way to zoom in without opening the image in a separate tab.

## Proposed Solution

Apply CSS `transform: scale() translate()` on a wrapper div around the existing `BBoxOverlay` component. This leverages the fact that `getBoundingClientRect()` returns post-transform bounds, so BBoxOverlay's existing coordinate math (`toNormalized`) continues to work without modification.

### Interaction Model

| Input | Action |
|-------|--------|
| Scroll wheel over image | Zoom in/out centered on cursor (1x–8x) |
| Space + left-click drag | Pan the view (when zoomed > 1x) |
| `z` key | Reset zoom to 1x |
| Left-click drag (no Space) | Draw bounding box (existing behavior, unchanged) |

### Key Design Decisions

- **Zoom resets on image navigation** (← → arrow keys). User always sees the full image first.
- **Bbox labels scale with zoom** (accepted tradeoff). Users can press `h` to hide boxes if labels obstruct the view at high zoom.
- **Space overrides box clicks** — when Space is held, clicking on a bounding box starts a pan instead of selecting the box. This is necessary because at high zoom, boxes may cover most of the visible area.
- **Touch/mobile deferred** — desktop mouse/trackpad is the primary target.
- **Zoom suppressed when dialogs are open** — prevents accidental zoom behind modals.

## Technical Approach

### Architecture

```
┌─ image container (existing div, overflow: hidden) ──────┐
│  ┌─ zoom wrapper (new div, CSS transform) ────────────┐ │
│  │  ┌─ BBoxOverlay (unchanged) ────────────────────┐  │ │
│  │  │  <img>                                        │  │ │
│  │  │  <svg> (boxes, labels, draw preview)          │  │ │
│  │  └──────────────────────────────────────────────┘  │ │
│  └────────────────────────────────────────────────────┘ │
│  [2.3x] zoom indicator (overlay, top-right)             │
└─────────────────────────────────────────────────────────┘
```

The existing image container already has `overflow-hidden` and `rounded-lg`, so it naturally clips the zoomed content.

### Zoom Math (cursor-centered)

```
newScale = clamp(oldScale * (1 + normalizedDelta * ZOOM_SPEED), 1, MAX_ZOOM)
newTranslateX = cursorX - ((cursorX - oldTranslateX) / oldScale) * newScale
newTranslateY = cursorY - ((cursorY - oldTranslateY) / oldScale) * newScale
```

Transform applied as `transform-origin: 0 0; transform: translate(tx, ty) scale(s)`.

### Pan Bounds

Clamp translate so at least 50% of the image remains visible in each axis. Prevents panning the image entirely out of view.

## Changes

### 1. New: `src/hooks/use-image-zoom.ts`

Custom hook managing zoom/pan state and event handlers.

**State:** `scale`, `translateX`, `translateY`, `isPanning` (Space held)

**Handlers:**
- `handleWheel(e: WheelEvent)` — zoom toward cursor, `preventDefault` to block page scroll. Uses `addEventListener` with `{ passive: false }` via `useEffect` (React's `onWheel` is passive).
- Space key tracking via `keydown`/`keyup` on `window` — sets `isPanning` state. `preventDefault` on Space keydown to prevent page scroll.
- Pointer handlers for pan-drag (only active when `isPanning && scale > 1`)

**Returns:**
- `wrapperRef` — ref for the zoom wrapper div
- `containerRef` — ref for the outer overflow container (for wheel events)
- `style` — CSS transform object for the wrapper: `{ transform, transformOrigin, willChange }`
- `scale` — current zoom level (for UI display)
- `isPanning` — whether Space is held (for cursor changes)
- `resetZoom()` — reset to 1x

**Wheel event normalization:**
- Normalize `deltaY` across `deltaMode` values (pixel, line, page)
- Both regular scroll and `ctrlKey` (trackpad pinch) trigger zoom
- Suppress when `imgSize` is 0 (image not loaded) or dialog is open

### 2. Modify: `src/app/camera-trap/results/[id]/images/[imageId]/image-annotation-client.tsx`

- Import and call `useImageZoom`
- Wrap `<BBoxOverlay>` in a zoom wrapper div with the computed `style`
- Attach `containerRef` to the existing image container div
- Pass `editable={!isPanning}` to `<BBoxOverlay>` to suppress drawing during pan
- Apply cursor class: `isPanning ? 'cursor-grab' : ''` on wrapper (overrides crosshair)
- Show zoom indicator badge when `scale > 1` (small "2.3x" overlay, top-right of image)
- Reset zoom in the `onNext`/`onPrev` callbacks
- Wire `onResetZoom` into `useAnnotationShortcuts`
- Pass `isDialogOpen` to the zoom hook to suppress zoom during dialogs

### 3. Modify: `src/hooks/use-annotation-shortcuts.ts`

- Add `onResetZoom?: () => void` to the interface
- Add `{ key: "z", description: "Restablecer zoom", category: "navigation" }` to SHORTCUTS
- Add `case "z"` in the switch: calls `o.onResetZoom?.()`

### 4. Modify: `src/components/annotation-help-panel.tsx`

Add zoom shortcuts to the keyboard shortcuts section:
- `Scroll` → `Zoom`
- `Espacio+arrastrar` → `Mover vista`
- `z` → `Restablecer zoom`

## Edge Cases

- **Image not loaded**: Suppress zoom when `imgSize.width === 0`
- **At 1x zoom**: Pan is a no-op (Space+drag does nothing useful). `z` key is also a no-op.
- **At max zoom (8x)**: Scroll-up does nothing, scroll-down still zooms out
- **Space keyup missed** (e.g., window loses focus while Space held): Reset `isPanning` on `blur` event
- **Drawing state**: The `isDrawing` ref inside BBoxOverlay prevents shortcuts. Zoom wheel should still work during drawing (it doesn't use keyboard shortcuts).
- **Bboxes hidden** (`h` key): Zoom/pan continues to work normally

## Acceptance Criteria

- [x] Scroll wheel zooms image centered on cursor position (1x–8x range)
- [x] Space + drag pans the zoomed image
- [x] Pan is bounded (image stays at least 50% visible)
- [x] `z` key resets zoom to 1x
- [x] Zoom resets when navigating to next/previous image
- [x] Bbox drawing still works while zoomed (when not holding Space)
- [x] Bbox selection/click still works while zoomed (when not holding Space)
- [x] Cursor changes to grab/grabbing during pan mode
- [x] Zoom indicator shows current level when zoomed > 1x
- [x] Zoom suppressed when dialogs are open
- [x] No changes to BBoxOverlay coordinate math
- [x] Help panel documents new shortcuts

## References

- `src/components/bbox-overlay.tsx` — SVG overlay, `toNormalized()`, pointer events
- `src/app/camera-trap/results/[id]/images/[imageId]/image-annotation-client.tsx` — annotation page state management
- `src/hooks/use-annotation-shortcuts.ts` — keyboard shortcut handling
- `src/components/annotation-help-panel.tsx` — shortcut documentation
- `docs/solutions/ui-bugs/biochoco-overview-horizontal-scroll-map-overlap.md` — `min-w-0` flex gotcha for overflow containers
