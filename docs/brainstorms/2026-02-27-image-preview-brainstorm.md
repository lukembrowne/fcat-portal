# Camera Trap Image Preview (Without Processing)

**Date**: 2026-02-27

## What We're Building

Add the ability to view camera trap images from a deployment without running the ML processing pipeline. Currently, images can only be viewed after processing completes (via job results). This feature lets users preview what a camera captured before deciding whether to process it.

**Use case**: Get a general sense of what animals/activity the camera captured before committing to processing.

## Key Decisions

1. **Two new buttons in the deployments table** (not just the expanded row):
   - **"Ver Imagenes"** — links to a new preview page. Always visible, disabled when no images exist.
   - **"Procesar"** — queues processing immediately with one click. Disabled when status is `unscanned`, `processing`, or no images.

2. **New preview page** at `/camera-trap/[id]/preview`:
   - Thumbnail grid using existing `/api/ct-images/[id]?size=thumb` API
   - Lightbox on click: full-size image with next/prev navigation
   - No detection or species data — just raw images, filenames, timestamps
   - Header with deployment name, image count, and a "Procesar" button
   - Pagination or virtual scroll for large deployments

3. **Viewer style**: Grid with lightbox (thumbnail grid that opens full-size lightbox on click with next/prev navigation inside).

4. **Availability**: "Ver Imagenes" button always visible in table, grayed out when `totalImages` is 0 or null. Works at any status once images have been scanned.

5. **Process button behavior**: One click queues processing with default ML settings (same as expanded row "Procesar").

## Architecture

- Reuses existing image serving API (`/api/ct-images/[id]`) — no new API routes needed
- Reuses existing `biochoco_images` data (populated during scan step)
- New server action to fetch images for a deployment without requiring a job ID
- New route `/camera-trap/[id]/preview` with server + client components
- Lightbox component (new, or lightweight library)
- Two new columns in `deployments-table.tsx`

## What We're NOT Building

- No annotation or detection features on the preview page
- No changes to the existing results page
- No new image processing or caching logic
