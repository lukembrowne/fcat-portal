---
title: "feat: Deployment/Retrieval Image Tagging + Bulk Blank Image Deletion"
type: feat
date: 2026-03-03
---

# Deployment/Retrieval Image Tagging + Bulk Blank Image Deletion

## Overview

Two related improvements to the camera trap annotation pipeline:

1. **Setup tagging** — Tag images as "instalación" (deployment) or "recogida" (retrieval) to mark when the field team set up or took down the camera. Use the tagged image's timestamp as a suggestion for the deployment's `validStart`/`validEnd` QA dates.

2. **Bulk blank deletion** — Replace the current multi-select checkbox approach with a single "Eliminar imágenes vacías" button that opens a confirmation dialog with scope options and image counts.

## Problem Statement

**Tagging:** Field teams always appear in the first and last images of a deployment (setup/takedown). These images currently have no special status — researchers must manually note the timestamps and enter them as deployment dates. This is tedious and error-prone.

**Deletion:** The current workflow for deleting blank images requires: (1) admin role, (2) clicking individual checkboxes on each image, (3) confirming via the floating action bar. This is slow, visually cluttered, and doesn't scale for deployments with hundreds of blanks.

## Proposed Solution

### Part 1: Setup Tag

Add a `setup_tag` text column to `biochoco_images` with values `null | 'deployment' | 'retrieval'`. Expose tagging via:
- Button group in the annotation page detection strip area
- Keyboard shortcuts: `i` (instalación) and `t` (retiro)
- Visual badges on the image grid (blue "Instalación", orange "Recogida")
- Inline banner suggesting `validStart`/`validEnd` date when a tag is set

### Part 2: Bulk Blank Deletion

Replace the multi-select UI with a "Eliminar vacías" button in the sidebar filters panel. The button opens a dialog with:
- Scope checkboxes: "Confirmadas vacías" and "Sin detecciones"
- Dynamic count of images matching the selected scope
- Warning about Drive trash (30-day recovery)
- Explicit confirm button

Remove the existing multi-select checkboxes, floating action bar, and "select all blanks" bar entirely.

---

## Technical Approach

### Schema Change

**File:** `src/db/schema.ts`

Add to `biochoco_images` table:

```typescript
setupTag: text("setup_tag"),  // 'deployment' | 'retrieval' | null
```

No index needed — queried per-deployment, not globally. Run `push-schema.mjs` after adding.

### Phase 1: Setup Tag — Server Actions

**File:** `src/app/camera-trap/actions.ts`

#### `toggleSetupTag(imageId: number, tag: 'deployment' | 'retrieval')`

```typescript
// Requires "editor" permission
// If current setupTag === tag → set to null (toggle off)
// Otherwise → set to tag
// Returns: { setupTag: string | null, suggestion: { field: string, value: string, deploymentId: number } | null }
//
// When setting a tag:
// 1. Look up the image's exifTimestamp (preferred) or fileModified (fallback)
// 2. Format as "YYYY-MM-DDTHH:mm" (matches datetime-local input format)
// 3. If tag === 'deployment' → suggest validStart
//    If tag === 'retrieval' → suggest validEnd
// 4. Return the suggestion object so the client can show the inline banner
//
// When clearing a tag:
// - Do NOT clear validStart/validEnd (they were manually confirmed, so they persist)
```

#### `applySetupTagDate(deploymentId: number, field: 'validStart' | 'validEnd', value: string)`

```typescript
// Requires "editor" permission
// Sets the specified QA date field on the deployment
// Reuses the existing updateDeploymentQa pattern
// Logs to activityLog
```

### Phase 2: Setup Tag — Annotation Page UI

**File:** `src/app/camera-trap/results/[id]/images/[imageId]/image-annotation-client.tsx`

Add below the detection card strip (where the "Imagen confirmada como vacía" banner appears):

```
┌───────────────────────────────────────────────────┐
│  [📷 Instalación]  [📷 Recogida]                  │  ← toggle buttons
│                                                   │
│  ┌─ suggestion banner (when tag is set) ─────┐   │
│  │ ℹ Timestamp: 2026-01-15 10:30             │   │
│  │ ¿Usar como fecha de inicio (validStart)?  │   │
│  │                        [Aplicar] [Cerrar]  │   │
│  └────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────┘
```

- Buttons use outline variant by default, primary fill when active
- Active state shows the current tag visually (e.g., blue fill for deployment)
- Clicking an active button clears the tag (toggle behavior)
- Suggestion banner appears below buttons when a tag is set and a timestamp is available
- "Aplicar" calls `applySetupTagDate` server action
- "Cerrar" dismisses the banner (does not clear the tag)
- If no timestamp available (neither exifTimestamp nor fileModified), show "Sin timestamp disponible" instead of the suggestion

**File:** `src/hooks/use-annotation-shortcuts.ts`

Add keyboard shortcuts:
- `i` → toggle setupTag 'deployment' (instalación)
- `t` → toggle setupTag 'retrieval' (retiro)

Both are already unused keys.

### Phase 3: Setup Tag — Grid Badges

**File:** `src/components/image-grid.tsx`

Add badge rendering for setupTag in the badge priority chain:

```
Priority: setupTag > confirmedBlank > multi-detection count > zero-detection "Vacía"
```

- `setupTag === 'deployment'` → blue badge "Instalación" (Camera icon)
- `setupTag === 'retrieval'` → orange badge "Recogida" (Camera icon)
- These take priority over confirmedBlank since they carry more specific meaning

**File:** `src/app/camera-trap/results/[id]/page.tsx`

Pass `setupTag` in the `gridImages` data shape (add to the existing mapping at ~line 122).

### Phase 4: Bulk Blank Deletion — Server Action

**File:** `src/app/camera-trap/actions.ts`

#### `countDeletableImages(jobId: number, scope: { confirmedBlank: boolean, noDetections: boolean })`

```typescript
// Requires "admin" permission
// Returns: { confirmedBlankCount: number, noDetectionsCount: number, totalCount: number }
//
// confirmedBlankCount: images where confirmedBlank=true
//   - INCLUDES images with detections if ALL identifications are rejected
//   - EXCLUDES images with setupTag set (protect QA data)
//
// noDetectionsCount: images with zero detection rows
//   - EXCLUDES images with setupTag set
//
// totalCount: union of selected scopes (deduplicated)
```

#### `bulkDeleteBlankImages(jobId: number, scope: { confirmedBlank: boolean, noDetections: boolean })`

```typescript
// Requires "admin" permission
//
// Step 1: Query eligible images based on scope (same logic as countDeletableImages)
//   - For confirmedBlank scope: also include images where all identifications are rejected
//     (override the existing safety check that skips images with ANY detections)
//   - For confirmedBlank images with detections: delete their detections first, then the image
//   - EXCLUDE images with setupTag != null
//
// Step 2: Process deletion in batches of 50 (existing DELETE_BATCH_SIZE)
//   - Trash from Drive via trashFile()
//   - Clean up local cache + thumbnail
//   - Delete detections (if any remain), then delete image DB row
//
// Step 3: Update deployments.totalImages count
// Step 4: Log to activityLog with scope details
//
// Returns: ActionResult<{ deleted: number, failed: number, skipped: number }>
```

### Phase 5: Bulk Blank Deletion — UI

**File:** `src/app/camera-trap/results/[id]/results-client.tsx`

**Remove:**
- Individual checkbox selection on `<ImageGrid>` (remove `selectable` prop entirely)
- Floating selection action bar (lines 262-286)
- "Select all blanks" bar (lines 289-304)
- `selectedIds` state and related handlers
- `<BatchDeleteImagesDialog>` import and usage

**Add to sidebar filters card** (after the existing filters, before the "Limpiar" button):

```
┌─ Sidebar ────────────────────────────┐
│  Filtros                             │
│  ┌ Species filter ─────────────────┐ │
│  │ ...                             │ │
│  └─────────────────────────────────┘ │
│  Confidence slider                   │
│  Verification filter                 │
│  ☐ Mostrar imágenes sin detecciones  │
│  ☐ Solo destacadas                   │
│                                      │
│  ─────────────── separator ───────── │
│                                      │
│  Herramientas           (admin only) │
│  [🗑 Eliminar vacías]                │
│                                      │
│  Limpiar                             │
└──────────────────────────────────────┘
```

- "Herramientas" section only rendered when `isAdmin === true`
- Button uses `variant="outline"` with destructive color hint

**New file:** `src/app/camera-trap/results/[id]/bulk-delete-blanks-dialog.tsx`

```
┌─ Eliminar imágenes vacías ───────────────────────────┐
│                                                       │
│  Seleccione las imágenes a eliminar:                  │
│                                                       │
│  ☑ Imágenes confirmadas vacías           (42)         │
│  ☐ Imágenes sin detecciones              (67)         │
│                                                       │
│  ─────────────────────────────────────────────────    │
│  Total a eliminar: 42 imágenes                        │
│                                                       │
│  ⚠ Las imágenes se moverán a la papelera de          │
│    Google Drive y se pueden recuperar durante          │
│    30 días.                                           │
│                                                       │
│  ℹ Imágenes con etiqueta de instalación/recogida     │
│    serán excluidas.                                   │
│                                                       │
│                         [Cancelar]  [Eliminar (42)]   │
└───────────────────────────────────────────────────────┘
```

- Counts fetched via `countDeletableImages` server action on dialog open and checkbox change
- "Eliminar" button disabled when totalCount === 0 or no checkbox selected
- After successful deletion: `router.refresh()` to reload the grid
- Show result toast: "42 imágenes eliminadas" or "38 eliminadas, 4 fallaron"

---

## Acceptance Criteria

### Setup Tagging

- [x] New `setup_tag` column exists on `biochoco_images` (null default)
- [x] Annotation page shows [Instalación] [Recogida] toggle buttons below detection strip
- [x] Keyboard shortcuts `i` and `t` toggle the respective tags
- [x] Active tag shows filled button state + inline suggestion banner with timestamp
- [x] "Aplicar" button sets `validStart` or `validEnd` on the deployment
- [x] Dismissing the banner does not clear the tag
- [x] Clearing a tag does not clear previously applied validStart/validEnd
- [x] Image grid shows blue "Instalación" / orange "Recogida" badges
- [x] Setup tag badges take priority over confirmedBlank badges
- [x] Tags require "editor" permission

### Bulk Blank Deletion

- [x] Multi-select checkboxes and floating action bar removed from results page
- [x] "Eliminar vacías" button appears in sidebar for admins only
- [x] Dialog shows scope checkboxes with live image counts
- [x] "Confirmadas vacías" scope includes images with only rejected detections
- [x] Images with `setupTag` are excluded from deletion
- [x] "Sin detecciones" scope includes images with truly zero detection rows
- [x] Counts update dynamically when checkboxes change
- [x] Deletion result shown via toast notification
- [x] Grid refreshes after deletion
- [x] Activity log records bulk deletion with scope details
- [x] Deletion requires "admin" permission

### Edge Cases

- [x] Image with no timestamp: suggestion banner shows "Sin timestamp disponible" (no Aplicar button)
- [x] Zero deletable images: button disabled or dialog shows "No hay imágenes para eliminar"
- [x] Video frames: tagging allowed but suggestion notes that frame timestamps may be unreliable
- [x] Multiple images tagged as deployment in same deployment: allowed, each shows its own suggestion independently

---

## Files to Modify

| File | Change |
|------|--------|
| `src/db/schema.ts` | Add `setupTag` column to `biochoco_images` |
| `src/app/camera-trap/actions.ts` | Add `toggleSetupTag`, `applySetupTagDate`, `countDeletableImages`, `bulkDeleteBlankImages` |
| `src/app/camera-trap/results/[id]/page.tsx` | Pass `setupTag` in gridImages data |
| `src/app/camera-trap/results/[id]/results-client.tsx` | Remove multi-select, add sidebar delete button |
| `src/app/camera-trap/results/[id]/images/[imageId]/image-annotation-client.tsx` | Add setup tag buttons + suggestion banner |
| `src/hooks/use-annotation-shortcuts.ts` | Add `i` and `t` shortcuts |
| `src/components/image-grid.tsx` | Add setup tag badge rendering |
| `src/app/camera-trap/results/[id]/bulk-delete-blanks-dialog.tsx` | New dialog component |
| `scripts/push-schema.mjs` | Run after schema change |

## Dependencies & Risks

- **Safety check override**: Allowing deletion of confirmedBlank images that have rejected detections is a relaxation of the existing safety check. Mitigated by: (1) only applies to confirmedBlank scope, (2) requires all identifications to be rejected, (3) admin-only, (4) Drive trash is recoverable for 30 days.
- **setupTag exclusion in bulk delete**: Prevents accidental deletion of QA-annotated images, but users may not understand why certain blanks aren't being deleted. Addressed with the info note in the dialog.
- **Timestamp format**: `exifTimestamp` is text, `fileModified` is integer timestamp. Must normalize to `YYYY-MM-DDTHH:mm` format before suggesting for `validStart`/`validEnd`. Match the format used by the QA datetime-local inputs in `deployment-expanded-row.tsx`.

## Implementation Order

1. Schema change + push
2. Server actions (toggleSetupTag, applySetupTagDate)
3. Annotation page UI (buttons, shortcuts, suggestion banner)
4. Grid badges
5. Server actions (countDeletableImages, bulkDeleteBlankImages)
6. Bulk delete dialog + sidebar integration
7. Remove multi-select UI

## References

- Existing blank toggle: `src/app/camera-trap/actions.ts:3177-3246`
- Existing delete logic: `src/app/camera-trap/actions.ts:1520-1641`
- QA date fields: `src/db/schema.ts:156-158`
- Keyboard shortcuts: `src/hooks/use-annotation-shortcuts.ts`
- Grid badges: `src/components/image-grid.tsx:209-227`
- Batch delete dialog (to be replaced): `src/app/camera-trap/batch-delete-images-dialog.tsx`
- Annotation UX brainstorm: `docs/brainstorms/2026-02-15-annotation-ux-overhaul-brainstorm.md`
