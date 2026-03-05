---
title: "Refactor: Camera Trap Code Deduplication"
type: refactor
date: 2026-03-05
---

# Refactor: Camera Trap Code Deduplication

## Overview

The last 5 commits introduced public share links, bulk delete enhancements, dropdown actions, and confirm dialogs. A code review identified 6 deduplication/efficiency issues. This plan addresses each with minimal, targeted refactoring.

## Items

### 1. Extract shared thumbnail constants and generation helper

**Problem**: `THUMBNAIL_DIR`, `THUMBNAIL_WIDTH`, `THUMBNAIL_QUALITY` are declared identically in 4 files. The "check cache -> try local -> try Drive -> write cache" flow is duplicated between the auth and public image routes (~40 lines each).

**Files affected**:
- `src/app/api/ct-images/[id]/route.ts:26-28` (constants + generation at lines 136-182)
- `src/app/api/public/ct-images/[token]/[id]/route.ts:22-24` (constants + generation at lines 79-132)
- `src/lib/drive-downloader.ts:25-28` (constants only, different batch pattern)
- `src/app/camera-trap/drive-actions.ts:309` (THUMBNAIL_DIR only, used for deletion)

**Plan**:

Create `src/lib/thumbnail.ts`:

```typescript
import path from "path";
import { promises as fs } from "fs";
import sharp from "sharp";

export const THUMBNAIL_DIR = path.join(process.cwd(), "data", "thumbnails");
export const THUMBNAIL_WIDTH = 400;
export const THUMBNAIL_QUALITY = 80;

/** Build the cache path for a thumbnail. */
export function thumbnailPath(deploymentId: number, imageId: number): string {
  return path.join(THUMBNAIL_DIR, String(deploymentId), `${imageId}.jpg`);
}

/**
 * Get or generate a cached thumbnail.
 * Tries: cache hit -> local file -> Drive download.
 * Returns the JPEG buffer, or null if no source available.
 */
export async function getOrGenerateThumbnail(
  imageId: number,
  deploymentId: number,
  localPath: string | null,
  driveFileId: string | null,
  downloadFn: (fileId: string) => Promise<Buffer>,
): Promise<Buffer | null> {
  const thumbPath = thumbnailPath(deploymentId, imageId);

  // 1. Cache hit
  try {
    return await fs.readFile(thumbPath);
  } catch { /* miss */ }

  // 2. Try local file
  if (localPath) {
    try {
      const data = await fs.readFile(localPath);
      const thumb = await sharp(data)
        .resize(THUMBNAIL_WIDTH)
        .jpeg({ quality: THUMBNAIL_QUALITY })
        .toBuffer();
      await fs.mkdir(path.dirname(thumbPath), { recursive: true });
      await fs.writeFile(thumbPath, thumb);
      return thumb;
    } catch { /* fall through */ }
  }

  // 3. Try Drive
  if (!driveFileId) return null;
  const buffer = await downloadFn(driveFileId);
  const thumb = await sharp(buffer)
    .resize(THUMBNAIL_WIDTH)
    .jpeg({ quality: THUMBNAIL_QUALITY })
    .toBuffer();
  await fs.mkdir(path.dirname(thumbPath), { recursive: true });
  await fs.writeFile(thumbPath, thumb);
  return thumb;
}
```

Then refactor both image routes to call `getOrGenerateThumbnail()` after their respective auth checks. The `drive-downloader.ts` batch pattern is different enough (parallel batches, non-fatal errors, progress callbacks) that it should just import the constants + `thumbnailPath()` rather than the full helper.

**Acceptance criteria**:
- [x] New `src/lib/thumbnail.ts` with constants + `thumbnailPath()` + `getOrGenerateThumbnail()`
- [x] `src/app/api/ct-images/[id]/route.ts` uses shared helper (removes ~30 lines)
- [x] `src/app/api/public/ct-images/[token]/[id]/route.ts` uses shared helper (removes ~30 lines)
- [x] `src/lib/drive-downloader.ts` imports constants + `thumbnailPath()` from shared module
- [x] `src/app/camera-trap/drive-actions.ts` imports `THUMBNAIL_DIR` or `thumbnailPath()` from shared module
- [x] Existing tests still pass; manual smoke test of thumbnail serving

---

### 2. Extract bulk delete eligibility helper + single-fetch optimization

**Problem**: `countDeletableImages` (lines 1702-1836) and `bulkDeleteBlankImages` (lines 1838-2044) share ~100 lines of identical eligibility logic (DB queries + Set construction). Additionally, the dialog re-fetches counts on every checkbox toggle (up to 3 extra server calls).

**Plan**:

**Step A**: Extract shared eligibility computation:

```typescript
// In actions.ts (non-exported helper)
interface EligibilitySets {
  eligible: typeof images.$inferSelect[];
  detectionsByImg: Map<number, number[]>;
  imagesWithOnlyRejected: Set<number>;
  detectionsWithVerifiedOrCorrectedOrRejected: Set<number>;
  jobTotalCount: number;
}

async function computeEligibilitySets(jobId: number): Promise<EligibilitySets> {
  // All the shared DB queries + Set construction (~80 lines, once)
}
```

Both `countDeletableImages` and `bulkDeleteBlankImages` call this helper, then apply their specific logic (counting vs deleting).

**Step B**: Return all three counts in one call:

Change `countDeletableImages` to always compute all three scope counts regardless of which `scope` flags are set:

```typescript
export async function countDeletableImages(jobId: number): Promise<ActionResult<{
  confirmedBlankCount: number;
  noDetectionsCount: number;
  unverifiedDetectionsCount: number;
  jobTotalCount: number;
}>>
```

**Step C**: Update `bulk-delete-blanks-dialog.tsx`:

- Fetch all counts once on mount (no `scope` parameter)
- Compute `totalCount` client-side as the sum of enabled checkbox counts
- Remove per-checkbox `fetchCounts()` calls

Note: The three categories may overlap (an image could be both "confirmed blank" and "no detections"), so the server should return a `unionCount` or the client should handle this. Check current behavior — if the current `totalCount` accounts for overlap, the server should also return a `totalIfAll` count, or the categories should be mutually exclusive by design.

**Acceptance criteria**:
- [x] `computeEligibilitySets()` extracted as shared helper
- [x] `countDeletableImages` simplified to use helper, returns all 3 counts always
- [x] `bulkDeleteBlankImages` simplified to use helper
- [x] Dialog fetches counts once on mount, checkbox toggles update totals client-side
- [x] Verify overlap handling is correct (test with real data scenarios)
- [x] Existing `camera-trap-bulk-delete.test.ts` tests pass (update signatures as needed)

---

### 3. Extract `useConfirmPreview` hook for confirm dialogs

**Problem**: 4 confirm dialogs (compress, delete, process, revert) share identical state management: `useState` for preview, `useEffect` with cancellation flag for fetching, confirm handler pattern.

**Research finding**: A full generic `ConfirmActionDialog<T>` component would be over-engineered because each dialog has unique conditional content (admin checkbox in process, cascade stats in delete, etc.). A shared hook is more effective.

**Plan**:

Create `src/hooks/use-confirm-preview.ts`:

```typescript
import { useState, useEffect, useCallback } from "react";
import type { ActionResult } from "@/lib/types";

export function useConfirmPreview<T>(
  triggerId: number | null,
  fetchFn: (id: number) => Promise<ActionResult<T>>,
) {
  const [preview, setPreview] = useState<T | null>(null);

  useEffect(() => {
    if (!triggerId) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    fetchFn(triggerId).then((result) => {
      if (!cancelled && result.success) {
        setPreview(result.data);
      }
    });
    return () => { cancelled = true; };
  }, [triggerId, fetchFn]);

  return preview;
}
```

Refactor each dialog to use:

```typescript
const preview = useConfirmPreview(deploymentId, getCompressionPreview);
```

This removes ~15 lines of boilerplate per dialog (60 lines total across 4 dialogs).

**Acceptance criteria**:
- [x] New `src/hooks/use-confirm-preview.ts` with generic hook
- [x] `compress-confirm-dialog.tsx` uses hook
- [x] `delete-confirm-dialog.tsx` uses hook
- [x] `revert-confirm-dialog.tsx` uses hook
- [ ] `process-confirm-dialog.tsx` uses hook (skipped — dual-preview pattern is too different)
- [x] All dialogs behave identically to before (manual smoke test)

---

### 4. Extract image timestamp ordering constant

**Problem**: `sql\`COALESCE(${images.exifTimestamp}, ${images.fileModified})\`` appears 5 times with identical secondary sort by `images.filename`.

**Locations**:
- `src/app/camera-trap/[id]/preview/page.tsx:41`
- `src/app/camera-trap/results/[id]/page.tsx:59`
- `src/app/camera-trap/actions.ts:2646`
- `src/app/camera-trap/actions.ts:3807`
- `src/app/camera-trap/actions.ts:3820`

**Plan**:

Add to existing `src/db/schema.ts` (or a new `src/lib/query-helpers.ts` if schema.ts shouldn't have query logic):

```typescript
import { sql } from "drizzle-orm";
import { images } from "@/db/schema";

/** Standard ordering for camera trap images: EXIF timestamp -> file modified -> filename */
export const IMAGE_TIMESTAMP_ORDER = sql`COALESCE(${images.exifTimestamp}, ${images.fileModified})`;
```

Replace all 5 instances with:
```typescript
.orderBy(IMAGE_TIMESTAMP_ORDER, images.filename)
```

**Acceptance criteria**:
- [x] `IMAGE_TIMESTAMP_ORDER` constant exported from appropriate module
- [x] All 5 instances replaced
- [x] TypeScript compiles without errors

---

### 5. Fetch all bulk delete counts in one call (client-side toggle)

This is merged into Item 2 above (Step B + Step C). No separate work item needed.

---

### 6. Add nginx rate limiting for public endpoints

**Problem**: `/public/` and `/api/public/` routes are unauthenticated. No rate limiting exists anywhere in the nginx config.

**Plan**:

Add rate limit zones before the `server` block in `nginx/portal.fcat-ecuador.org`:

```nginx
# Rate limiting for unauthenticated endpoints
limit_req_zone $binary_remote_addr zone=public_api:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=public_pages:10m rate=5r/s;
```

Add `limit_req` directives to the public location blocks:

```nginx
location /api/public/ {
    limit_req zone=public_api burst=30 nodelay;
    # ... existing config ...
}

location /public/ {
    limit_req zone=public_pages burst=15 nodelay;
    # ... existing config ...
}
```

The `/api/public/` rate is higher (10r/s, burst 30) because a single page load triggers N image requests. A share page with 50 images needs to load all thumbnails quickly. The `/public/` rate is lower (5r/s, burst 15) since it's just page loads.

**Acceptance criteria**:
- [x] Rate limit zones added to nginx config
- [x] `limit_req` added to both `/public/` and `/api/public/` location blocks
- [ ] Test locally with `docker compose up` that public pages still load correctly
- [ ] Verify rate limiting works: `for i in $(seq 1 50); do curl -s -o /dev/null -w "%{http_code}\n` https://portal.fcat-ecuador.org/public/share/test; done` (should see 429s after burst)

## Implementation Order

1. **Item 4** (IMAGE_TIMESTAMP_ORDER constant) — smallest, zero risk, quick win
2. **Item 1** (thumbnail helper) — moderate scope, well-understood pattern
3. **Item 3** (useConfirmPreview hook) — moderate scope, UI-only change
4. **Item 2** (bulk delete eligibility + single-fetch) — largest scope, requires test updates
5. **Item 6** (nginx rate limiting) — infrastructure, deploy separately

## References

- Security review findings: conversation context (2026-03-05)
- Thumbnail implementations: `src/app/api/ct-images/[id]/route.ts`, `src/app/api/public/ct-images/[token]/[id]/route.ts`, `src/lib/drive-downloader.ts`
- Bulk delete logic: `src/app/camera-trap/actions.ts:1702-2044`
- Confirm dialogs: `src/app/camera-trap/{compress,delete,process,revert}-confirm-dialog.tsx`
- COALESCE instances: `actions.ts:2646,3807,3820`, `preview/page.tsx:41`, `results/[id]/page.tsx:59`
- Nginx config: `nginx/portal.fcat-ecuador.org`
