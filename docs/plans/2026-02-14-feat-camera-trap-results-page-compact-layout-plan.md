---
title: "feat: Compact layout for camera trap results page"
type: feat
date: 2026-02-14
---

# feat: Compact layout for camera trap results page

## Overview

Reorganize the camera trap results page (`/camera-trap/results/[id]`) to prioritize the image gallery. Remove redundant stats, drop the species distribution chart, and consolidate key info into a compact summary bar so the gallery is visible immediately without scrolling.

## Problem Statement

The current page renders — in order — 5 stat cards, a verification progress card, and a species distribution chart before the user ever sees the image gallery. Most of this is redundant (the header already shows processing progress and model name) or low-priority (species distribution). The primary workflow is reviewing and verifying detections, which requires the gallery.

## Proposed Solution

### New Layout (Top to Bottom)

```
Breadcrumb
Header (deployment name, status badge, "50/50 imgs procesadas", detector model, action buttons)
Compact Summary Bar: "52 detecciones · 10 especies · 0/52 verificadas · Clasificador: [model]"
  ↳ Conditionally: "· 3 fallidas" (only if failedImages > 0)
Two-Column Layout:
  Left: Filter Sidebar (unchanged — species list, confidence slider, verification filter, show empty)
  Right: Image Gallery (unchanged — lazy loaded grid)
```

### What Gets Removed
- 5 `StatCard` components and grid (lines 168-178 in `page.tsx`)
- Verification Progress `Card` (lines 180-207)
- Species Distribution `Card` (lines 209-243)
- `StatCard` function definition (lines 255-264)

### What Gets Added
- Compact summary bar between header and two-column layout
- Classification model name (`job.classifierModel`) in the summary bar

### What Stays Unchanged
- Breadcrumb navigation
- Header section (deployment name, status badge, processing progress, detector model, action buttons)
- `ResultsClient` component and all filter/gallery logic
- `ImageGrid` component
- All data fetching and computation logic (species counts, verification counts still needed for summary bar and filters)

## Acceptance Criteria

- [x] Image gallery is visible without scrolling on a standard viewport (1080p)
- [x] Species distribution chart is removed
- [x] 5 stat cards are removed
- [x] Verification progress card is removed
- [x] Compact summary bar shows: detections count, species count, verification progress, classifier model name
- [x] Failed images count shown conditionally (only when > 0)
- [x] Classification model name (`job.classifierModel`) is displayed; gracefully handles null (some jobs may not have a classifier)
- [x] Filter sidebar remains functional and unchanged
- [x] Image gallery remains functional and unchanged
- [x] Page still works for jobs with 0 detections / 0 identifications

## Implementation Steps

### Step 1: Modify `src/app/camera-trap/results/[id]/page.tsx`

1. **Remove the Stats Grid** (lines 168-178): Delete the entire `grid gap-4 md:grid-cols-5` div with the 5 `StatCard` components.

2. **Remove the Verification Progress Card** (lines 180-207): Delete the entire conditional `Card` block.

3. **Remove the Species Distribution Card** (lines 209-243): Delete the entire conditional `Card` block.

4. **Remove the `StatCard` function** (lines 255-264): No longer needed.

5. **Remove unused imports**: `Card`, `CardContent`, `CardHeader`, `CardTitle` — if no longer used in this file after the removals.

6. **Add compact summary bar** between the header and `ResultsClient`. This is a simple `div` with inline text — no new components needed:

```tsx
{/* Compact Summary */}
<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground mb-4">
  <span><strong className="text-foreground">{jobDetections.length}</strong> detecciones</span>
  <span>·</span>
  <span><strong className="text-foreground">{Object.keys(speciesCount).length}</strong> especies</span>
  <span>·</span>
  <span>
    <strong className="text-foreground">{verified}</strong> de {jobIdentifications.length} verificadas
    {unverified > 0 && <span className="ml-1">({unverified} pendientes)</span>}
  </span>
  {job.failedImages > 0 && (
    <>
      <span>·</span>
      <span className="text-destructive">
        <strong>{job.failedImages}</strong> fallidas
      </span>
    </>
  )}
  {job.classifierModel && (
    <>
      <span>·</span>
      <span>Clasificador: {job.classifierModel}</span>
    </>
  )}
</div>
```

7. **Reduce header bottom margin** from `mb-8` to `mb-4` since the summary bar follows immediately.

### Step 2: Verify

- Run `npm run build` to catch any compilation errors
- Manually verify the page renders correctly with the new layout

## References

- Brainstorm: `docs/brainstorms/2026-02-14-camera-trap-results-page-ui-update-brainstorm.md`
- Results page: `src/app/camera-trap/results/[id]/page.tsx`
- Results client: `src/app/camera-trap/results/[id]/results-client.tsx`
- Schema (classifierModel): `src/db/schema.ts:138`
