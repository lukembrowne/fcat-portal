# Camera Trap — Favorite/Star Images

**Date**: 2026-02-18
**Status**: Ready for planning

## What We're Building

A way to star/favorite standout camera trap images for curation — collecting the best wildlife photos for reports, presentations, social media, and outreach. Shared across the team with attribution (who starred it), and browsable both within a job's results and across all deployments.

## Why This Approach

Boolean flag on `biochoco_images` (like `confirmedBlank`) — simplest approach that matches existing patterns. Single attribution is sufficient for a small team.

## Key Decisions

1. **Purpose**: Curating best photos (not workflow flagging)
2. **Visibility**: Shared across team with attribution (who starred it)
3. **Where to star**: Annotation view only (single-image page)
4. **Browsing**: Filter in existing job results grid + new cross-deployment gallery page
5. **Un-star**: Anyone with access can un-star (not just the person who starred)
6. **Data model**: Boolean flag approach — add `isFavorite`, `favoritedBy`, `favoritedAt` columns to `biochoco_images` table (same pattern as `confirmedBlank`)

## Scope

### In scope
- `isFavorite` / `favoritedBy` / `favoritedAt` columns on `biochoco_images`
- Star/un-star toggle on the image annotation page
- "Destacadas" filter option in the job results sidebar
- New `/camera-trap/favorites` gallery page showing all starred images across deployments
- Star badge on image cards in the grid when an image is favorited

### Out of scope
- Per-user favorites (everyone shares one set of stars)
- Starring from the grid view (annotation view only for now)
- Notes or comments on why an image was starred
- Export of favorited images

## Open Questions

None — ready for planning.
