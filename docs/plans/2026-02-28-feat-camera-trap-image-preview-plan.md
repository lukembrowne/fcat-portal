---
title: "feat: Camera trap image preview without processing"
type: feat
date: 2026-02-28
---

# Camera Trap Image Preview Without Processing

## Overview

Add the ability to view camera trap images from a deployment without running the ML processing pipeline. Two new buttons directly in the deployments table ("Ver Imagenes" and "Procesar"), plus a new preview route that reuses existing grid and image view components with annotation controls hidden.

**Brainstorm**: `docs/brainstorms/2026-02-27-image-preview-brainstorm.md`

## Motivation

Currently, images can only be viewed after completing the full ML processing pipeline. Users want to preview what a camera captured before deciding whether to commit to processing — to get a general sense of animal activity and camera quality.

## Proposed Solution

### 1. Two new action buttons in the deployments table

Add two icon buttons in the table row, before the existing "Resultados" column:

| Button | Icon | Tooltip | Action | Disabled when |
|--------|------|---------|--------|---------------|
| Ver Imagenes | `Images` | "Ver Imagenes" | Navigate to `/camera-trap/[id]/preview` | `totalImages` is 0/null |
| Procesar | `Play` | "Procesar" | Call `queueProcessing([id])` | status is `unscanned` or `processing`, or no images |

**File**: `src/app/camera-trap/deployments-table.tsx`

Add two new column definitions before the existing `results` column (~line 287):

```tsx
{
  id: "preview",
  header: "",
  cell: ({ row }) => {
    const hasImages = (row.original.totalImages ?? 0) > 0;
    if (!hasImages) return null;
    return (
      <Link
        href={`/camera-trap/${row.original.id}/preview`}
        onClick={(e) => e.stopPropagation()}
        className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 hover:underline whitespace-nowrap"
      >
        <Images className="h-3.5 w-3.5" />
        Imagenes
      </Link>
    );
  },
  enableSorting: false,
  enableGlobalFilter: false,
},
```

For the "Procesar" button — needs `canEdit` check and loading state. Use a small inline button that calls `queueProcessing([row.original.id])` directly. Disable when status is `unscanned`, `processing`, or no images. Show spinner during processing.

### 2. New preview grid page: `/camera-trap/[id]/preview`

**New file**: `src/app/camera-trap/[id]/preview/page.tsx` (Server Component)

Reuses the pattern from `src/app/camera-trap/results/[id]/page.tsx` but simplified:

- Query `biochoco_images` by `deploymentId` (not `jobId`)
- No detection/identification joins
- Map images to `ImageGridItem[]` with empty `detections: []`
- Pass to a modified `ImageGrid` (or `PreviewGrid` wrapper)

**Layout**:
```
Breadcrumb: Cámaras Trampa / {deployment.name} / Vista Previa
Header: deployment name, image count, "Procesar" button (editor only)
Grid: thumbnail grid (no filter sidebar)
```

**Server action needed**: `getDeploymentImages(deploymentId)` — returns all images for a deployment, ordered by filename. This is simpler than `getDeployment()` which also loads jobs. Returns `{ deployment, images, videos }`.

**File**: `src/app/camera-trap/actions.ts` — add new action (~5 lines):
```ts
export async function getDeploymentImages(deploymentId: number) {
  const user = await requirePermission("camera-trap", "viewer");
  await requireDeploymentAccess(user, deploymentId);
  const depImages = await db.select().from(images)
    .where(eq(images.deploymentId, deploymentId))
    .orderBy(images.filename);
  return depImages;
}
```

### 3. Modify `ImageGrid` to support preview mode

**File**: `src/components/image-grid.tsx`

Make `jobId` optional. Add a `basePath` prop to control where image cards link to:

```tsx
interface ImageGridProps {
  images: ImageGridItem[];
  jobId?: number;
  basePath?: string; // e.g. "/camera-trap/5/preview" for preview mode
}
```

In `ImageCard`, compute the link href:
- If `basePath` provided: `${basePath}/${image.id}`
- Else (existing behavior): `/camera-trap/results/${jobId}/images/${image.id}`

The detection overlays in `ImageCard` already handle empty `detections: []` gracefully — the badges simply don't render. No changes needed there.

### 4. New preview image page: `/camera-trap/[id]/preview/[imageId]`

**New file**: `src/app/camera-trap/[id]/preview/[imageId]/page.tsx` (Server Component)

Reuses the layout pattern from `src/app/camera-trap/results/[id]/images/[imageId]/page.tsx` but without annotation:

- Load image via `getImageWithDetections(imgId)` (already works without a job)
- Get image navigation via new action `getDeploymentImageIds(deploymentId)` (similar to `getJobImageIds`)
- Render full-size image with prev/next navigation
- **No** `ImageAnnotationClient` — instead, render a simple image viewer
- Show: filename, deployment name, image counter ("3 de 245"), prev/next buttons, star toggle
- Don't show: bounding boxes, species sidebar, verify/reject buttons, manual detection, confirm blank

**New server action**: `getDeploymentImageIds(deploymentId)` — returns ordered array of image IDs for prev/next navigation.

**File**: `src/app/camera-trap/actions.ts`:
```ts
export async function getDeploymentImageIds(deploymentId: number): Promise<number[]> {
  const user = await requirePermission("camera-trap", "viewer");
  await requireDeploymentAccess(user, deploymentId);
  const rows = await db.select({ id: images.id }).from(images)
    .where(eq(images.deploymentId, deploymentId))
    .orderBy(images.filename);
  return rows.map(r => r.id);
}
```

**Preview image view** — simple component (no separate client component needed for MVP):

```tsx
// Full-size image display (no annotation)
<div className="max-w-7xl mx-auto">
  {/* Breadcrumb */}
  {/* Header: filename, deployment name, N de M, prev/next buttons */}
  {/* Full-size image */}
  <div className="relative bg-muted rounded-lg overflow-hidden">
    <img src={`/api/ct-images/${imageId}?size=full`} alt={filename} className="w-full" />
  </div>
</div>
```

## Acceptance Criteria

- [x] "Ver Imagenes" link appears in deployments table for all deployments with images
- [x] "Ver Imagenes" link is absent (not just disabled) when `totalImages` is 0/null
- [x] "Procesar" button appears in table for editors when deployment has images and isn't processing/unscanned
- [x] Clicking "Procesar" in table queues processing immediately with loading feedback
- [x] Preview grid page loads all deployment images as thumbnails
- [x] Preview grid page has a "Procesar" button in the header (editors only)
- [x] Clicking a thumbnail navigates to full-size preview with prev/next
- [x] Full-size preview has no annotation controls (no bounding boxes, species, verify)
- [x] Preview works at any deployment status (scanned, processed, verified, etc.)
- [x] Permission checks enforced: viewer can view, only editor can process
- [x] CT project-level access checks enforced on preview routes
- [x] Large deployments (1000+ images) load efficiently via lazy-loaded thumbnails

## Edge Cases

- **0 images**: Button hidden in table; preview page shows "No hay imagenes" message
- **Deployment mid-processing**: Preview still works (shows images scanned so far)
- **Image load failures**: Existing error state in `ImageCard` handles this (shows "Sin vista previa")
- **Video frames**: Shown in preview grid grouped by video (existing `ImageGrid` logic)
- **Concurrent process click**: `queueProcessing` is idempotent — skips if already processing

## Implementation Order

1. Add `getDeploymentImages()` and `getDeploymentImageIds()` server actions
2. Modify `ImageGrid` to accept optional `basePath` prop
3. Create `/camera-trap/[id]/preview/page.tsx` (grid page)
4. Create `/camera-trap/[id]/preview/[imageId]/page.tsx` (image view page)
5. Add "Ver Imagenes" and "Procesar" columns to `deployments-table.tsx`

## Files Changed

| File | Change |
|------|--------|
| `src/app/camera-trap/actions.ts` | Add `getDeploymentImages()`, `getDeploymentImageIds()` |
| `src/components/image-grid.tsx` | Make `jobId` optional, add `basePath` prop |
| `src/app/camera-trap/[id]/preview/page.tsx` | **New** — preview grid page |
| `src/app/camera-trap/[id]/preview/[imageId]/page.tsx` | **New** — full-size image preview |
| `src/app/camera-trap/deployments-table.tsx` | Add "Ver Imagenes" link + "Procesar" button columns |
