---
title: "refactor: Remove Annotations Page and Sidebar Item"
type: refactor
date: 2026-02-12
---

# refactor: Remove Annotations Page and Sidebar Item

## Overview

Remove the `/camera-trap/annotate` page and its sidebar navigation item. Verification of ML predictions is already handled by the image detail view at `/camera-trap/results/[id]/images/[imageId]`, which uses the same `BBoxOverlay` and `AnnotationToolbar` components. The annotation queue page is redundant and its sidebar link is a dead-end (requires `?jobId=X` to function).

## Problem Statement

The "Anotaciones" sidebar item links to `/camera-trap/annotate`, which immediately shows "No se especificó un trabajo" and tells the user to go to the Results page first. The only working entry point is the "Anotar" button on the results detail page. Meanwhile, clicking any image in the results grid already opens the image detail view with the full annotation toolbar — making the queue page redundant for an MVP with a small team.

## Proposed Solution

Delete the annotate route entirely and remove the sidebar link. Update the one reference on the results detail page to remove the "Anotar" button (since users can click any image to verify it).

## Changes

### 1. Delete annotate route (2 files)

- Delete `src/app/camera-trap/annotate/page.tsx`
- Delete `src/app/camera-trap/annotate/annotate-client.tsx`

### 2. Remove sidebar item

**File:** `src/components/sidebar-nav.tsx:121`

Remove this line:
```tsx
{ label: "Anotaciones", href: "/camera-trap/annotate" },
```

### 3. Remove "Anotar" button from results detail page

**File:** `src/app/camera-trap/results/[id]/page.tsx:155-160`

Remove the "Anotar (N pendientes)" button that links to the now-deleted annotate page. The unverified count can stay visible as text if useful, or be removed entirely.

### 4. Shared components — NO changes needed

These are still used by the image detail view and stay as-is:
- `src/components/annotation-toolbar.tsx` — used by `image-detail-client.tsx`
- `src/components/bbox-overlay.tsx` — used by `image-detail-client.tsx`

## Acceptance Criteria

- [x] `/camera-trap/annotate` route no longer exists
- [x] Sidebar shows only "Dashboard" and "Resultados" under Cámaras Trampa
- [x] Results detail page has no broken link to annotate
- [x] Image detail view (`/camera-trap/results/[id]/images/[imageId]`) still works with full verify/reject/correct functionality
- [x] `npm run build` passes (TypeScript clean; Turbopack fails on pre-existing ml-venv symlink issue)
- [x] No orphaned imports

## References

- Annotation queue (being removed): `src/app/camera-trap/annotate/`
- Image detail view (keeping): `src/app/camera-trap/results/[id]/images/[imageId]/`
- Shared toolbar: `src/components/annotation-toolbar.tsx`
- Sidebar nav: `src/components/sidebar-nav.tsx:114-124`
