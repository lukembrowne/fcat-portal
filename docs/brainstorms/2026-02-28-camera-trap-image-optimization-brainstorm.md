# Camera Trap Image Optimization

**Date**: 2026-02-28
**Status**: Ready for planning

## What We're Building

Two complementary features to manage camera trap image storage as real data volumes grow:

### 1. Image Compression (Re-encode on Drive)

A batch action that re-encodes JPEG images at quality 85 without resizing, replacing the originals on Google Drive. Reduces ~20MB images to ~4-5MB with no perceptible quality loss and no resolution change.

- **Trigger**: Manual "Comprimir Imagenes" button on the deployment expanded row
- **Permission**: Admin only (modifies originals on Drive)
- **Mechanism**: Download (or use cache) -> re-encode with `sharp` at JPEG quality 85 -> upload back to Drive replacing original
- **Tracking**: `compressed` boolean flag on the `images` table to skip already-compressed images
- **Progress**: Show progress indicator during batch operation

### 2. Blank Image Deletion from Drive

A batch review-and-delete workflow for images with 0 ML detections. Enhances the existing image grid with selection controls, then deletes confirmed blanks from Google Drive.

- **UI**: Checkboxes on 0-detection images in the existing results grid
- **Bulk select**: "Seleccionar todas las vacias" button to select all candidate blanks at once
- **Delete action**: "Eliminar seleccionadas de Drive" button with confirmation dialog (count + irreversibility warning)
- **Cleanup**: Deletes from Drive via API, removes image rows from DB, cleans up local cache + thumbnails
- **Permission**: Admin only (destructive, affects Drive)

## Why This Approach

- **Re-encode only (no resize)**: Since we're unsure about long-term use cases for full resolution, re-encoding preserves all pixel data while still achieving ~4-5x size reduction. The cameras save at quality 95-100 which is wasteful.
- **Separate batch action (not integrated into ML pipeline)**: Keeps compression decoupled from processing. Can be run independently, retroactively on already-processed deployments.
- **Batch review then delete (not auto-delete)**: ML isn't perfect — MegaDetector might miss a distant or camouflaged animal. Showing candidate blanks in a reviewable grid with bulk-select balances speed with safety.
- **Enhance existing grid (not new view)**: The image grid already shows "Vacia" badges. Adding checkboxes and bulk actions is less new UI to build and keeps users in a familiar interface.

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Compression strategy | Re-encode JPEG at Q85, no resize | Safest big win — ~4-5x savings, no resolution loss |
| Where to compress | On Drive (replace originals) | Solves the real problem (Drive storage cost) |
| Compression timing | Separate batch action | Decoupled from ML pipeline, can run retroactively |
| Blank detection | ML 0-detections as candidates, human confirms | ML isn't perfect, humans verify before deletion |
| Blank review UI | Enhance existing image grid | Less new UI, familiar interface |
| Deletion target | Google Drive (actual file deletion) | Frees real storage space |
| Permission level | Admin only for both features | Both modify/delete originals on Drive |

## Open Questions

- Should we log deleted file IDs to an audit table for traceability? (Nice to have but not critical for v1)
- Should compression handle non-JPEG formats (PNG, TIFF) by converting to JPEG? Or skip them?
- What happens if Drive API rate limits are hit during a large batch? Need retry/backoff logic.
- Should the "select all blanks" also skip images that have manual detections added after ML found nothing?

## Technical Notes

- `sharp` is already a dependency (used for thumbnail generation)
- Drive API file update: `drive.files.update()` with new media body replaces content in-place (same fileId)
- The existing `confirmedBlank` flag could be reused or a new selection mechanism could be independent
- LRU cache eviction already handles local cleanup; compressed images would be smaller in cache too
- MegaDetector resizes internally to ~1280px, so compression doesn't affect ML accuracy at all
