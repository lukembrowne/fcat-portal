# Brainstorm: Per-Image Blank Confirmation in Camera Trap Pipeline

**Date:** 2026-02-17
**Status:** Ready for planning

## What We're Building

A per-image "confirmed blank" mechanism for the camera trap annotation workflow. Researchers press `b` during annotation to confirm that an image is truly blank (no wildlife), creating a tracked record that a human reviewed it. This builds confidence that the ML pipeline didn't miss anything.

## Why This Approach

Currently, blank images (0 ML detections) show a "Vacia" badge but there's no record of whether a human actually reviewed and confirmed the image is blank. The `verified_empty` status only exists at the deployment level. Researchers need per-image confirmation for data quality and confidence tracking.

**Chosen approach:** Simple `confirmed_blank` boolean column on the `images` table. Simplest solution that solves the problem without over-engineering.

## Key Decisions

1. **`b` key toggles confirmed blank** on any image (not just images with 0 detections)
2. **Marking blank on an image with detections** rejects all identifications (preserves ML output for false positive tracking)
3. **Toggle behavior** — pressing `b` again un-confirms blank
4. **Deployment-level `verified_empty` stays independent** — no auto-rollup from per-image confirmations
5. **UI feedback in two places:**
   - Image grid: upgraded badge (e.g., "Vacia" with checkmark or different color)
   - Annotation page: visual indicator (banner or checkmark)
6. **Mark only, no auto-advance** — researcher decides when to navigate

## Scope

### In scope
- `confirmed_blank` boolean column on `images` table
- `toggleConfirmedBlank` server action (with permission check)
- `b` keyboard shortcut in annotation page
- Batch-reject identifications when marking blank on image with detections
- Badge upgrade in image grid for confirmed-blank images
- Visual indicator on annotation page
- Update help panel with new shortcut

### Out of scope
- Auto-rollup to deployment `verified_empty`
- Audit trail (who/when confirmed)
- Batch blank confirmation from the grid view
- "Advance to next blank" navigation

## Open Questions

None — design is clear enough to proceed to planning.
