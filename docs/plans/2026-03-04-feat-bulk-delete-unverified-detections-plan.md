---
title: "feat: Add bulk delete option for images with unverified detections + require setup/retrieval tags"
type: feat
date: 2026-03-04
---

# Bulk Delete: Unverified Detections Option + Setup/Retrieval Gate

## Overview

Enhance the existing bulk delete blanks dialog (`bulk-delete-blanks-dialog.tsx`) with two changes:

1. **New deletion scope**: Add a third checkbox option — "Imágenes con detecciones sin verificar" — to also delete images where the model produced detections but none have been verified (common false positives on blank images). Excludes images with any verified/corrected identifications.
2. **Gate on setup/retrieval tags**: Block deletion until at least one image in the job has been tagged as `deployment` (instalación) and one as `retrieval` (recogida), ensuring the user has scanned through the photos first.

## Problem Statement

The ML model often produces false-positive detections on blank images. Currently, the only options for cleaning these up are:
- Manually marking each detection as rejected or each image as blank
- Using "Imágenes sin detecciones" which skips anything with detections (even false positives)

Users scanning through photos should be able to delete images that have detections but where none of those detections have been verified — these are overwhelmingly false positives on blank images.

Additionally, deletion should only be allowed after the user has designated the instalación and recogida images, confirming they've scanned through the deployment photos.

## Proposed Solution

### UI Changes — `bulk-delete-blanks-dialog.tsx`

Add a third checkbox between the existing two:

```
☑ Imágenes confirmadas vacías (0)
   Marcadas con "Vacía" y sin identificaciones activas.

☑ Imágenes sin detecciones (1859)
   El modelo no detectó nada.

☐ Imágenes con detecciones sin verificar (NEW)
   Todas las detecciones están sin verificar — posibles falsos positivos.
   Imágenes con identificaciones verificadas o corregidas no se incluyen.
```

Add a warning banner at the top when setup/retrieval tags are missing:

```
⚠ Debe designar las imágenes de instalación y recogida antes de eliminar.
[Disabled "Siguiente" button]
```

### Server Action Changes — `actions.ts`

**`countDeletableImages`** and **`bulkDeleteBlankImages`**:

- Extend `scope` type: `{ confirmedBlank: boolean; noDetections: boolean; unverifiedDetections: boolean }`
- New scope logic for `unverifiedDetections`:
  - Image has ≥1 detection
  - ALL identifications across all detections have `verificationStatus = 'unverified'` (none are verified, corrected, or rejected)
  - Still excludes `setupTag` images and those without `driveFileId`
- Add new count field: `unverifiedDetectionsCount`
- Add a new server action `checkSetupRetrievalTags(jobId)` that returns `{ hasDeployment: boolean; hasRetrieval: boolean }` — queries whether any image in the job has `setupTag = 'deployment'` and any has `setupTag = 'retrieval'`

### Gate Logic

The dialog fetches `checkSetupRetrievalTags` on mount. If either tag is missing:
- Show warning banner explaining what's needed
- Disable the "Siguiente" button
- Checkboxes remain interactive (user can see counts) but can't proceed

## Acceptance Criteria

- [ ] New "Imágenes con detecciones sin verificar" checkbox appears in the dialog with accurate count
- [ ] Selecting this option deletes images where all identifications are `unverified` (not `verified`, `corrected`, or `rejected`)
- [ ] Images with ANY verified or corrected identification are excluded
- [ ] Images with rejected-only identifications are NOT included in this scope (they're already handled by `confirmedBlank`)
- [ ] `setupTag` images and images without `driveFileId` still excluded from all scopes
- [ ] Deletion is blocked until both `deployment` and `retrieval` tags exist on at least one image each in the job
- [ ] Warning message shown when tags are missing
- [ ] Activity log records the new scope option
- [ ] Existing tests still pass
- [ ] New test cases cover the `unverifiedDetections` scope

## Files to Modify

1. **`src/app/camera-trap/actions.ts`** (~1677-1960)
   - Extend `scope` type with `unverifiedDetections: boolean`
   - Add `unverifiedDetectionsCount` to return type and counting logic
   - Add `unverifiedDetections` filtering in delete function
   - Add `checkSetupRetrievalTags()` server action

2. **`src/app/camera-trap/results/[id]/bulk-delete-blanks-dialog.tsx`**
   - Add third checkbox + state
   - Add setup/retrieval gate with warning banner
   - Fetch `checkSetupRetrievalTags` on mount
   - Pass new scope field through to actions

3. **`tests/integration/camera-trap-bulk-delete.test.ts`**
   - Add test images with unverified detections
   - Test `unverifiedDetections` counting
   - Test that verified/corrected images are excluded
   - Test setup/retrieval gate

## Technical Notes

- The `unverifiedDetections` scope is distinct from `noDetections` (which has 0 detections) and `confirmedBlank` (which is explicitly marked blank). It targets images the model flagged but nobody has reviewed yet.
- For the identification status check, query all identifications for eligible images and check that NONE have `verificationStatus` in `['verified', 'corrected']`. Images with only `rejected` identifications are already coverable by the `confirmedBlank` scope.
- The setup/retrieval check is a lightweight query — just check `EXISTS` for each tag value in the images table for the given job.

## References

- Existing dialog: `src/app/camera-trap/results/[id]/bulk-delete-blanks-dialog.tsx`
- Server actions: `src/app/camera-trap/actions.ts:1677-1960`
- Schema `setupTag`: `src/db/schema.ts:262`
- Schema `verificationStatus`: `src/db/schema.ts:348-352`
- Tests: `tests/integration/camera-trap-bulk-delete.test.ts`
