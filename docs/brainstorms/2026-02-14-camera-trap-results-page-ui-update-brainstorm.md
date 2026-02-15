# Brainstorm: Camera Trap Results Page UI/UX Update

**Date:** 2026-02-14

## What We're Building

A major UI/UX overhaul of the camera trap results page (`/camera-trap/results/[id]`) to prioritize the image gallery and reduce above-the-fold clutter.

### Current Problems
- Stats grid (5 cards), verification progress, and species distribution chart consume the entire viewport before the user ever sees any images
- Stats are redundant with header info (header already shows "50/50 imagenes procesadas" and model name)
- Species distribution chart takes significant space and isn't essential for the primary workflow (reviewing/verifying detections)

## Key Decisions

1. **Remove species distribution chart** entirely for now
2. **Move image gallery to the top** — immediately below a compact summary bar
3. **Replace 5 stat cards with a compact inline summary** showing only non-redundant info: detections count, species count, verification progress, and classification model name
4. **Keep filter sidebar** alongside the gallery (current 240px left sidebar layout)
5. **Add classification model** to the display (stored in `jobs.classifierModel` but not currently shown)

## New Layout (Top to Bottom)

```
Breadcrumb
Header (deployment name, status badge, "50/50 imgs procesadas", detector model, action buttons)
Compact Summary Bar: "52 detecciones · 10 especies · 0/52 verificadas · Clasificador: [model]"
Two-Column Layout:
  Left: Filter Sidebar (species list, confidence slider, verification filter, show empty)
  Right: Image Gallery (full grid, lazy loaded)
```

### What Gets Removed
- 5 stat cards grid (Total Imagenes, Procesadas, Fallidas, Detecciones, Especies)
- Species distribution bar chart
- Verification progress card (absorbed into compact summary bar)

### What Gets Added
- Classification model name display
- Compact inline summary bar

## Open Questions

- Should "Fallidas" (failed images count) still be shown somewhere if > 0? Could conditionally display in the summary bar only when non-zero.
- Exact visual treatment of the compact summary bar (subtle background card, inline text with separators, etc.) — to be decided during implementation.
