---
title: "feat: Camera Trap Image Compression & Blank Deletion"
type: feat
date: 2026-02-28
brainstorm: docs/brainstorms/2026-02-28-camera-trap-image-optimization-brainstorm.md
---

# Camera Trap Image Compression & Blank Deletion

## Overview

Two features to manage camera trap storage as real data comes in. Sites generate ~2000 images at ~20MB each (~40GB/site). Most images are blank. These features: (1) re-encode JPEGs at quality 85 on Google Drive (~4-5x savings, no resolution loss), and (2) batch-review and delete blank images from Drive.

## Problem Statement

Camera trap images are stored on Google Shared Drive at full camera quality (~20MB/image). This wastes storage (cameras encode at quality 95-100 needlessly) and bandwidth. Additionally, most images at a site are blank (no animal detected) — manually reviewing and deleting these one-by-one is impractical.

## Proposed Solution

### Feature 1: Batch Image Compression

Admin-only batch action on a deployment that re-encodes all JPEG images at quality 85 using `sharp`, uploads the compressed version back to Drive (replacing the original), and tracks compression status per image.

### Feature 2: Batch Blank Image Deletion

Enhance the existing image results grid with checkboxes on blank images (0 detections). Admin can bulk-select blanks, review them visually, then delete selected images from Drive (soft-delete to trash for 30-day recovery). Removes image rows from DB and cleans up local cache/thumbnails.

## Technical Approach

### Phase 1: Foundation (Drive API + Schema)

#### 1.1 Add Drive API helper functions

**File:** `src/lib/drive-client.ts`

Add two new functions following existing patterns (`supportsAllDrives: true` on every call):

```typescript
// Replace file content on Drive (for compression)
async function updateFileContent(
  fileId: string,
  buffer: Buffer,
  mimeType: string
): Promise<void>

// Soft-delete file to Drive trash (for blank deletion)
async function trashFile(fileId: string): Promise<void>
```

Both must include:
- `supportsAllDrives: true`
- Exponential backoff on 429/403 rate limit errors (3 retries, 1s/2s/4s delays)
- Follow the existing batch pattern: process in groups of 5 via `Promise.allSettled()` to prevent one failure from cascading

#### 1.2 Add `compressed` column to images table

**File:** `src/db/schema.ts`

Add to the `images` table:
```typescript
compressed: integer("compressed", { mode: "boolean" }).notNull().default(false),
```

**File:** `scripts/push-schema.mjs`

Add ALTER TABLE migration (idempotent, try/catch ignores duplicate column):
```javascript
`ALTER TABLE biochoco_images ADD COLUMN compressed INTEGER NOT NULL DEFAULT 0`,
```

### Phase 2: Compression Feature

#### 2.1 Server action for compression

**File:** `src/app/camera-trap/drive-actions.ts` (or new `compression-actions.ts`)

```typescript
export async function compressDeploymentImages(
  deploymentId: number
): Promise<ActionResult<{ compressed: number; skipped: number; failed: number; savedBytes: number }>>
```

Logic:
1. `requirePermission("camera-trap", "admin")` + `requireDeploymentAccess()`
2. Guard: deployment must be `processed`, `verified`, or `verified_empty` status; not `processing`
3. Query all images where `compressed = false` AND `driveFileId IS NOT NULL` AND filename ends in `.jpg`/`.jpeg`
4. Process in batches of 5:
   - Download from local cache (if exists) or Drive
   - Re-encode: `sharp(buffer).jpeg({ quality: 85 }).toBuffer()`
   - Upload back: `updateFileContent(driveFileId, compressedBuffer, "image/jpeg")`
   - Update DB: set `compressed = true`, update `fileSize` to new size
   - Replace local cache file with compressed version
   - Delete thumbnail (will be regenerated on next request — already small, but ensures consistency)
5. Track totals: compressed count, skipped (non-JPEG, no driveFileId), failed, bytes saved
6. Log one `activityLog` entry with summary
7. Return summary

**Note on long-running operations:** For v1, use a direct server action (not a background job). Compression processes in batches of 5 with `Promise.allSettled()`, so each batch completes quickly. The server action streams results back. If a deployment has 2000 images but most are already compressed (re-run after partial failure), it skips quickly. If timeouts become an issue with very large deployments, we can add a job-based pattern later (YAGNI for now).

#### 2.2 UI: Compression button on deployment row

**File:** `src/app/camera-trap/deployment-expanded-row.tsx`

Add a "Comprimir Imagenes" button in the action buttons section:
- Visible when: `canEdit` AND deployment has project-level admin AND status is `processed`/`verified`/`verified_empty` AND `totalImages > 0`
- Uses `useTransition` pattern (like other buttons)
- Shows `Loader2` spinner while running
- On completion, shows toast with summary: "Comprimidas: X, Omitidas: Y, Errores: Z, Ahorro: N MB"
- Disabled if all images already compressed (query count where `compressed = false`)

### Phase 3: Blank Image Deletion Feature

#### 3.1 Server action for batch deletion

**File:** `src/app/camera-trap/actions.ts`

```typescript
export async function deleteImagesFromDrive(
  imageIds: number[]
): Promise<ActionResult<{ deleted: number; failed: number }>>
```

Logic:
1. `requirePermission("camera-trap", "admin")`
2. Query images by IDs — verify each has `driveFileId` and belongs to an accessible deployment
3. Validate: skip images that have any detections (including manual ones with `jobId = null`) as safety check
4. Process in batches of 5:
   - `trashFile(driveFileId)` — soft-delete to Drive trash (30-day recovery window)
   - Delete local cache file if exists: `data/cache/ct-images/{deploymentId}/{filename}`
   - Delete thumbnail if exists: `data/thumbnails/{deploymentId}/{imageId}.jpg`
   - Delete image row from DB (CASCADE removes any detections/identifications)
5. Update `deployments.totalImages` count
6. Log one `activityLog` entry with deleted image count, deployment ID, and list of deleted image IDs (in details JSON)
7. `revalidatePath` for the results page
8. Return summary

#### 3.2 UI: Selection controls on image grid

**File:** `src/components/image-grid.tsx`

Add optional selection mode to `ImageGrid`:
- New props: `selectable?: boolean`, `selectedIds?: Set<number>`, `onSelectionChange?: (ids: Set<number>) => void`
- When `selectable`, show a checkbox overlay on each card (top-left corner)
- Checkbox click toggles selection without navigating to the detail page
- Clicking the image area still navigates to detail page

**File:** `src/app/camera-trap/results/[id]/results-client.tsx`

Add selection state and toolbar:
- `const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())`
- Pass `selectable={isAdmin}` to `ImageGrid`
- When images are selected, show a floating action bar at the bottom:
  - "X seleccionadas" count
  - "Seleccionar todas las vacias" button — selects all images in current filtered view where `status === "processed"` AND `detections.length === 0` (including `confirmedBlank`)
  - "Deseleccionar todo" button
  - "Eliminar de Drive" button — opens confirmation dialog

**File:** `src/app/camera-trap/batch-delete-images-dialog.tsx` (new)

Confirmation dialog following existing `BatchDeleteDialog` pattern:
- Shows count of images to delete
- Warning text: "Esta accion movera X imagenes a la papelera de Google Drive. Los archivos se eliminaran permanentemente despues de 30 dias."
- "Las imagenes sin detecciones seran eliminadas. Las imagenes con detecciones manuales han sido excluidas."
- Confirm/Cancel buttons

## Acceptance Criteria

### Compression
- [x] Admin can click "Comprimir Imagenes" on a processed deployment
- [x] JPEGs are re-encoded at quality 85 and uploaded back to Drive (same fileId)
- [x] Non-JPEG images are skipped silently
- [x] Already-compressed images are skipped
- [x] Local cache is updated with compressed version
- [x] `images.fileSize` and `images.compressed` are updated in DB
- [x] Button shows progress and completion summary (count + bytes saved)
- [x] Button is hidden for non-admin users and non-processed deployments
- [x] Activity log entry created

### Blank Deletion
- [x] Admin sees checkboxes on image cards in the results grid
- [x] "Seleccionar todas las vacias" selects all 0-detection images in current view
- [x] Images with manual detections are excluded from "select all" and validated server-side
- [x] Confirmation dialog shows count and irreversibility warning
- [x] Files are soft-deleted to Drive trash (not permanently deleted)
- [x] Image rows removed from DB (cascade to detections/identifications)
- [x] Local cache and thumbnails cleaned up
- [x] Deployment totalImages count updated
- [x] Results grid refreshes after deletion
- [x] Activity log entry created with deleted image IDs

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Permission level | `requirePermission("camera-trap", "admin")` | More destructive than normal editor ops (modifying/deleting Drive originals) |
| Compression approach | Re-encode JPEG Q85, no resize | Safest — ~4-5x savings, no resolution loss |
| Long-running pattern | Direct server action (v1) | Simpler than job system; can upgrade later if needed |
| Drive deletion method | Soft-delete (trash) | 30-day recovery window as safety net |
| Non-JPEG handling | Skip | Converting formats changes file semantics; camera traps are ~100% JPEG |
| Blank definition | `status = "processed"` AND 0 total detections (incl. manual) | Excludes failed images and images with human-added detections |
| Audit logging | One entry per batch operation | Per-image would create thousands of entries |
| Cache after compression | Replace with compressed version | Prevents serving stale uncompressed files |
| Blank selection scope | Job-scoped UI (results page), but deletion validates per-image | Users review blanks in context of their ML results |

## Dependencies & Risks

**Dependencies:**
- `sharp` — already installed, used for thumbnails
- Google Drive API v3 — already integrated, need `files.update()` and `files.update({ trashed: true })`
- Schema migration — new `compressed` column, applied via `push-schema.mjs`

**Risks:**
- **Drive API rate limits**: Mitigated by batches of 5 + exponential backoff
- **Server action timeout on huge deployments**: Mitigated by batch processing; can add job system later if needed
- **Concurrent compression + ML processing**: Mitigated by only showing button when status is `processed` (not `processing`)
- **Accidental deletion of non-blank images**: Mitigated by server-side validation (skip images with any detections), soft-delete to trash, and manual selection review

## File Changes Summary

| File | Change |
|---|---|
| `src/db/schema.ts` | Add `compressed` column to images table |
| `scripts/push-schema.mjs` | Add ALTER TABLE migration |
| `src/lib/drive-client.ts` | Add `updateFileContent()` and `trashFile()` functions |
| `src/app/camera-trap/drive-actions.ts` | Add `compressDeploymentImages()` server action |
| `src/app/camera-trap/actions.ts` | Add `deleteImagesFromDrive()` server action |
| `src/app/camera-trap/deployment-expanded-row.tsx` | Add "Comprimir Imagenes" button |
| `src/components/image-grid.tsx` | Add optional selection mode (checkboxes) |
| `src/app/camera-trap/results/[id]/results-client.tsx` | Add selection state, toolbar, bulk-select |
| `src/app/camera-trap/batch-delete-images-dialog.tsx` | New confirmation dialog |

## References

- Brainstorm: `docs/brainstorms/2026-02-28-camera-trap-image-optimization-brainstorm.md`
- Drive client: `src/lib/drive-client.ts`
- Image schema: `src/db/schema.ts:218-262`
- Deployment expanded row: `src/app/camera-trap/deployment-expanded-row.tsx:363-459`
- Image grid: `src/components/image-grid.tsx`
- Results page: `src/app/camera-trap/results/[id]/results-client.tsx`
- Existing batch dialogs: `src/app/camera-trap/batch-delete-dialog.tsx`, `batch-edit-dialog.tsx`
- Institutional learning — Shared Drive flags: `docs/solutions/integration-issues/google-drive-recursive-file-counting-20260224.md`
- Institutional learning — ALTER TABLE migrations: `docs/solutions/database-issues/missing-alter-table-migrations-push-schema.md`
- Institutional learning — Sync transactions: `docs/solutions/runtime-errors/async-transaction-better-sqlite3-CameraTrap-20260223.md`
