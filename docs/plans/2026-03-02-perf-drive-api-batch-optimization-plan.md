---
title: Drive API Batch Size & Concurrency Optimization
type: perf
date: 2026-03-02
---

# Drive API Batch Size & Concurrency Optimization

## Overview

With a Google Drive API quota of 12,000 queries/min, the current batch sizes (5-10 for most operations) dramatically under-utilize available throughput. This plan bumps batch sizes, parallelizes sequential subfolder recursion, and adds `withRetry` to unprotected operations — all with test verification at each step.

## Current State

| Operation | File:Line | Batch | API calls/img | Retry? |
|---|---|---|---|---|
| Download images | `drive-client.ts:525` | 10 | 1 | Partial (1 retry, no backoff) |
| Upload frames | `drive-client.ts:797` | 5 | 1 | No |
| Delete images | `actions.ts:1458` | 5 | 1 | Yes (`withRetry`) |
| Revert compression | `drive-actions.ts:685` | 20 | 3 | Yes (`withRetry`) |
| Subfolder recursion | `drive-client.ts:472` | Sequential | 1/subfolder | No |
| Thumbnail generation | `drive-downloader.ts:121` | Sequential | 0 (local) | N/A |
| `downloadFileToBuffer` | `drive-client.ts:551` | N/A | 1 | No |
| Scan deployment (DB inserts) | `drive-actions.ts:252` | Sequential | 0 | N/A |

## Acceptance Criteria

- [ ] All batch size increases applied
- [ ] Subfolder recursion parallelized in `listMediaRecursive`, `countFilesRecursive`, `listFolderFiles`
- [ ] `withRetry` added to `downloadFileToBuffer`, `downloadFile`, listing functions
- [ ] Thumbnail generation batched
- [ ] Scan deployment uses batch DB inserts
- [ ] All 401+ existing tests still pass after each change
- [ ] `npm run build` succeeds after each change
- [ ] No functional regressions — each change is constant/pattern-only, no logic changes

## MVP

### Task 1: Bump download batch size (10 → 50)

**Files:**
- `src/lib/drive-client.ts:525` — change `BATCH_SIZE = 10` to `50`

**Why:** Downloads are the biggest bottleneck in ML processing. At 10, downloading 2000 images = 200 sequential batches. At 50, it's 40 batches. Each download is 1 API call, so 50 concurrent = 50 queries — well within 12,000/min.

**Verify:** `npm run test:run` (all pass), `npm run build` (succeeds)

**Commit:** `perf(drive): increase image download batch size from 10 to 50`

---

### Task 2: Bump upload frames batch size (5 → 20)

**Files:**
- `src/lib/drive-client.ts:797` — change `BATCH_SIZE = 5` to `20`

**Why:** Video frame uploads are conservative at 5. Each upload is 1 API call. 20 concurrent uploads is safe.

**Verify:** `npm run test:run`, `npm run build`

**Commit:** `perf(drive): increase frame upload batch size from 5 to 20`

---

### Task 3: Bump delete batch size (5 → 50)

**Files:**
- `src/app/camera-trap/actions.ts:1458` — change `DELETE_BATCH_SIZE = 5` to `50`

**Why:** Deleting 100 blank images currently = 20 batches. Each `trashFile` is 1 API call with `withRetry`. 50 concurrent is safe.

**Verify:** `npm run test:run`, `npm run build`

**Commit:** `perf(drive): increase image deletion batch size from 5 to 50`

---

### Task 4: Bump revert compression batch size (20 → 50)

**Files:**
- `src/app/camera-trap/drive-actions.ts:685` — change `REVERT_BATCH_SIZE = 20` to `50`

**Why:** Revert does 3 API calls per image (list revisions, download revision, upload restored). At 50 images = 150 API calls per batch. Still well within quota, and all 3 calls use `withRetry`.

**Verify:** `npm run test:run`, `npm run build`

**Commit:** `perf(drive): increase revert compression batch size from 20 to 50`

---

### Task 5: Add `withRetry` to `downloadFileToBuffer`

**Files:**
- `src/lib/drive-client.ts` — wrap `downloadFileToBuffer` body with `withRetry`

**Why:** This is used by compression (50 concurrent downloads per batch). Currently has zero retry protection — a single transient 429 kills the image. The `withRetry` helper already exists and handles 429/403 with exponential backoff.

**Implementation:**

```typescript
export async function downloadFileToBuffer(fileId: string): Promise<Buffer> {
  return withRetry(async () => {
    const drive = await getDrive();
    const res = await drive.files.get(
      { fileId, alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" },
    );
    return Buffer.from(res.data as ArrayBuffer);
  }, `downloadFileToBuffer(${fileId})`);
}
```

**Verify:** `npm run test:run`, `npm run build`

**Commit:** `fix(drive): add withRetry to downloadFileToBuffer for rate limit resilience`

---

### Task 6: Add `withRetry` to `downloadFile`

**Files:**
- `src/lib/drive-client.ts` — replace the manual 1-retry loop in `downloadFile` with `withRetry`

**Why:** `downloadFile` has a hand-rolled 1-retry loop with no status code check. The `withRetry` helper is more robust (checks 429/403 specifically, exponential backoff, 3 attempts).

**Verify:** `npm run test:run`, `npm run build`

**Commit:** `fix(drive): replace manual retry in downloadFile with withRetry`

---

### Task 7: Add `withRetry` to listing functions

**Files:**
- `src/lib/drive-client.ts` — wrap the `drive.files.list()` call inside `listDeploymentFolders`, `listMediaRecursive`, `countFilesRecursive`, and `listFolderFiles` with `withRetry`

**Why:** These functions make paginated `files.list` calls with no retry. During large scans (1000+ files across many subfolders), a single 429 causes the entire scan to fail. Wrapping just the `drive.files.list()` call (not the whole function) with `withRetry` adds resilience without changing behavior.

**Implementation pattern for each:**
```typescript
// Before:
const res = await drive.files.list({ ... });

// After:
const res = await withRetry(
  () => drive.files.list({ ... }),
  `files.list(${folderId})`
);
```

**Verify:** `npm run test:run`, `npm run build`

**Commit:** `fix(drive): add withRetry to all listing functions for rate limit resilience`

---

### Task 8: Parallelize subfolder recursion

**Files:**
- `src/lib/drive-client.ts` — update `listMediaRecursive`, `countFilesRecursive`, and `listFolderFiles`

**Why:** Currently subfolders are processed sequentially:
```typescript
for (const sub of subfolders) {
  const subResult = await listMediaRecursive(sub.id, ...);
}
```

If a deployment has 10 camera subfolders, this makes 10 sequential API calls. With `Promise.all`, they run in parallel.

**Implementation pattern:**
```typescript
// Before:
for (const sub of subfolders) {
  if (sub.name === "_frames") continue;
  const subResult = await listMediaRecursive(sub.id, subPath, depth + 1);
  imageFiles.push(...subResult.images);
  videoFiles.push(...subResult.videos);
}

// After:
const subResults = await Promise.all(
  subfolders
    .filter((sub) => sub.name !== "_frames")
    .map((sub) => listMediaRecursive(sub.id, subPath, depth + 1))
);
for (const subResult of subResults) {
  imageFiles.push(...subResult.images);
  videoFiles.push(...subResult.videos);
}
```

Apply same pattern to `countFilesRecursive` and `listFolderFiles`.

**Verify:** `npm run test:run` (existing tests for `listImagesRecursive` cover recursive behavior), `npm run build`

**Commit:** `perf(drive): parallelize subfolder recursion in listing functions`

---

### Task 9: Batch thumbnail generation

**Files:**
- `src/lib/drive-downloader.ts` — batch the sequential thumbnail loop in `downloadDeploymentForProcessing`

**Why:** After downloading images, thumbnails are generated one-at-a-time with sharp. For 2000 images, this is 2000 sequential sharp calls (~500ms each = ~16 min). Batching with `Promise.all` in groups of 20 cuts this significantly.

**Implementation:** Replace the sequential `for` loop with batched processing:
```typescript
const THUMB_BATCH_SIZE = 20;
for (let i = 0; i < driveImages.length; i += THUMB_BATCH_SIZE) {
  const batch = driveImages.slice(i, i + THUMB_BATCH_SIZE);
  await Promise.all(batch.map(async (img) => {
    // existing thumbnail generation logic per image
  }));
  if (onProgress) await onProgress(Math.min(i + THUMB_BATCH_SIZE, driveImages.length), driveImages.length);
}
```

**Verify:** `npm run test:run`, `npm run build`

**Commit:** `perf(drive): batch thumbnail generation in groups of 20`

---

### Task 10: Batch DB inserts in scanDeploymentImages

**Files:**
- `src/app/camera-trap/drive-actions.ts` — batch the sequential `db.insert` loop in `scanDeploymentImages`

**Why:** Inserting 2000 images one-at-a-time is slow. Drizzle supports multi-row inserts with `.onConflictDoNothing()`. Batch in groups of 100.

**Implementation:**
```typescript
// Before:
for (const img of media.images) {
  try {
    await db.insert(images).values({ ... }).onConflictDoNothing();
  } catch { /* skip */ }
}

// After:
const IMG_INSERT_BATCH = 100;
for (let i = 0; i < media.images.length; i += IMG_INSERT_BATCH) {
  const batch = media.images.slice(i, i + IMG_INSERT_BATCH);
  try {
    await db.insert(images).values(batch.map((img) => ({ ... }))).onConflictDoNothing();
  } catch { /* skip */ }
}
```

Same for videos.

**Verify:** `npm run test:run`, `npm run build`

**Commit:** `perf(drive): batch DB inserts in scanDeploymentImages`

---

### Task 11: Final verification

- Run full test suite: `npm run test:run`
- Run build: `npm run build`
- Run lint: `npm run lint`
- Verify git log shows clean sequence of perf/fix commits with no reverted changes

## References

- Drive API quota: 12,000 queries/min (confirmed from Google Cloud Console)
- `withRetry` helper: `src/lib/drive-client.ts:829-854`
- Institutional learning on Drive pagination: `docs/solutions/integration-issues/google-drive-recursive-file-counting-20260224.md`
- Institutional learning on inflight deduplication: `docs/solutions/runtime-errors/spectrogram-process-explosion-AudioCache-20260226.md`
