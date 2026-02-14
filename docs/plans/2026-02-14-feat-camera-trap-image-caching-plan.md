---
title: Camera Trap Image Caching
type: feat
date: 2026-02-14
---

# Camera Trap Image Caching

## Overview

Replace the disposable temp directory (`data/tmp/ct-job-{jobId}/`) with a persistent per-deployment image cache (`data/cache/ct-images/{deploymentId}/`). Images downloaded from Google Drive stay cached for ML processing, annotation viewing, and re-processing. LRU eviction at the deployment level keeps disk usage under a configurable limit.

## Problem Statement

Every ML processing run downloads all deployment images from Google Drive to a temp directory, processes them, then deletes everything. This causes three pain points:

1. **Re-processing wastes bandwidth** -- re-running with updated models re-downloads the full image set (typically 500 images, ~1-1.5 GB per deployment)
2. **Annotation is slow** -- after processing, viewing each full-size image for verification hits the Drive API individually (`downloadFileToBuffer()` at `src/app/api/ct-images/[id]/route.ts:192`)
3. **No cross-job benefit** -- thumbnails are cached (`data/thumbnails/`) but full images are always ephemeral

## Proposed Solution

Download to a persistent cache directory instead of a temp directory. Skip images that already exist in the cache. Keep `images.path` in the DB so the image proxy serves from disk. LRU eviction deletes the oldest deployment cache when total size exceeds the limit.

**Scale context:** <500 images per deployment (~1-1.5 GB each), 10-30 active deployments, 125 GB free on VPS. A 30 GB cache limit holds 20-30 deployments comfortably.

## Technical Approach

### Implementation Steps

#### Step 1: Refactor `downloadDeploymentForProcessing()` to use cache directory

**File:** `src/lib/drive-downloader.ts`

**Current behavior (lines 31-118):**
- Downloads to `data/tmp/ct-job-{jobId}/`
- Writes temp paths into `images.path`
- Returns `tempDir` for later cleanup

**New behavior:**
- Download to `data/cache/ct-images/{deploymentId}/`
- Before downloading each image, check if it already exists in cache (by filename) -- skip if present
- Write cache paths into `images.path`
- Return `cacheDir` instead of `tempDir`, plus count of `skipped` images
- Log how many were skipped vs downloaded

**Changes:**

```typescript
// src/lib/drive-downloader.ts

// Replace TEMP_BASE with CACHE_BASE
const CACHE_BASE = path.join(process.cwd(), "data", "cache", "ct-images");

export async function downloadDeploymentForProcessing(
  deploymentId: number,
  jobId: number,
  onProgress?: (downloaded: number, total: number) => Promise<void>
): Promise<{ cacheDir: string; downloaded: number; skipped: number; failed: number }> {
  const cacheDir = path.join(CACHE_BASE, String(deploymentId));
  await fs.mkdir(cacheDir, { recursive: true });

  // ... fetch driveImages same as before ...

  // Filter out images that are already cached
  const toDownload: DriveImageFile[] = [];
  const alreadyCached = new Map<string, string>(); // driveFileId → local path

  for (const img of driveImages) {
    const localPath = path.join(cacheDir, img.filename);
    try {
      await fs.access(localPath);
      alreadyCached.set(img.driveFileId!, localPath);
    } catch {
      toDownload.push(/* DriveImageFile for this img */);
    }
  }

  // Download only missing images
  const { downloaded, failed, pathMap } = await downloadDeploymentImages(toDownload, cacheDir);

  // Merge cached + newly downloaded paths
  for (const [fileId, localPath] of alreadyCached) {
    pathMap.set(fileId, localPath);
  }

  // Write paths into images.path + generate thumbnails (same loop as before)
  // ...

  console.log(
    `[drive-downloader] Job ${jobId}: ${alreadyCached.size} cached, ${downloaded} downloaded, ${failed} failed`
  );

  return { cacheDir, downloaded, skipped: alreadyCached.size, failed };
}
```

**Keep `TEMP_BASE` constant** for use in `cleanupOrphanedTempDirs()` (still needed for legacy cleanup).

#### Step 2: Remove cleanup calls from `processJobInternal()`

**File:** `src/app/camera-trap/actions.ts`

**Current:** `cleanupJobTempDir()` is called in 7 places (lines 171, 212, 254, 294, 394, 449, 752).

**Change:** Remove cleanup calls from the success path. Keep cleanup on error/failure paths but only for temp dirs (not cache dirs).

Specifically:
- **Line 254** (after ML completes successfully): **Remove** `cleanupJobTempDir()` call entirely -- cache persists
- **Line 171** (0 downloads): **Remove** -- cache dir should persist even if empty (might be retried)
- **Lines 212, 294** (ML unavailable, unhandled error): **Keep** but modify `cleanupJobTempDir()` to only clean temp dirs, not cache dirs (see Step 3)
- **Lines 394, 449, 752** (cancel/fail flows): Same -- keep but only clean temp dirs

Also update the import at line 16 and the `tempDir` variable name to `cacheDir` throughout `processJobInternal()`.

#### Step 3: Modify `cleanupJobTempDir()` to be cache-aware

**File:** `src/lib/drive-downloader.ts` (lines 123-150)

**Current:** Clears `images.path` for all job images and deletes the temp directory.

**New:** Only clear `images.path` and delete the directory if the path is in `data/tmp/` (legacy temp dirs). If the path is in `data/cache/`, leave it alone.

```typescript
export async function cleanupJobTempDir(
  jobId: number,
  tempDir?: string
): Promise<void> {
  const jobImages = await db
    .select()
    .from(images)
    .where(eq(images.jobId, jobId));

  for (const img of jobImages) {
    // Only clear paths that are in tmp (not cache)
    if (img.path && img.path.includes("/tmp/ct-job-")) {
      await db
        .update(images)
        .set({ path: null })
        .where(eq(images.id, img.id));
    }
  }

  // Only remove temp directories, not cache directories
  if (tempDir && tempDir.includes("/tmp/")) {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch { /* noop */ }
  }
}
```

#### Step 4: Update image proxy to use cached paths

**File:** `src/app/api/ct-images/[id]/route.ts` (lines 172-208)

**Current:** Full images always go to Drive API (`downloadFileToBuffer`). The `image.path` check at line 175 only triggers when `driveFileId` is null.

**New:** Check `image.path` first regardless of `driveFileId`. If the cached file exists on disk, serve it. Fall back to Drive API if path is null or file is missing.

```typescript
// --- Full image ---
// Check cache first (images.path may point to cached file)
if (image.path) {
  try {
    const data = await fs.readFile(image.path);
    return new NextResponse(new Uint8Array(data), {
      headers: { ...headers, "Content-Type": contentType },
    });
  } catch {
    // Cache miss (file deleted by eviction) — fall through to Drive
  }
}

// Fall back to Drive API
if (!image.driveFileId) {
  return NextResponse.json(
    { error: "No image source available" },
    { status: 404 }
  );
}

try {
  const buffer = await downloadFileToBuffer(image.driveFileId);
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      ...headers,
      "Content-Type": contentType,
      "Content-Length": buffer.length.toString(),
    },
  });
} catch (err) {
  // ... existing error handling ...
}
```

#### Step 5: Update `recoverStuckJobs()` to preserve cache

**File:** `src/db/index.ts` (lines 136-198)

**Current:** Clears `images.path` for stuck job images if path includes `/tmp/ct-job-` (line 166), then deletes all orphaned temp dirs (lines 181-194).

**Change:**
- Line 166: condition already only clears `/tmp/ct-job-` paths -- **no change needed**, cache paths are safe
- Lines 181-194: only cleans `ct-job-*` entries in `data/tmp/` -- **no change needed**, cache is in `data/cache/`

No changes required here. The existing path checks already distinguish temp from cache.

#### Step 6: Add LRU eviction

**File:** `src/lib/drive-downloader.ts` (new function)

Add an `evictIfOverLimit()` function called at the start of `downloadDeploymentForProcessing()`.

```typescript
const CT_CACHE_MAX_BYTES = (parseInt(process.env.CT_IMAGE_CACHE_MAX_GB || "30", 10)) * 1024 * 1024 * 1024;

async function evictIfOverLimit(currentDeploymentId: number): Promise<void> {
  try {
    const entries = await fs.readdir(CACHE_BASE);
    const dirStats: Array<{ name: string; size: number; mtime: Date }> = [];

    for (const entry of entries) {
      const dirPath = path.join(CACHE_BASE, entry);
      const stat = await fs.stat(dirPath);
      if (!stat.isDirectory()) continue;

      // Calculate directory size
      let dirSize = 0;
      const files = await fs.readdir(dirPath);
      for (const file of files) {
        const fileStat = await fs.stat(path.join(dirPath, file));
        dirSize += fileStat.size;
      }

      dirStats.push({ name: entry, size: dirSize, mtime: stat.mtime });
    }

    let totalSize = dirStats.reduce((sum, d) => sum + d.size, 0);

    // Sort by mtime ascending (oldest first)
    dirStats.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());

    // Evict oldest until under limit
    for (const dir of dirStats) {
      if (totalSize <= CT_CACHE_MAX_BYTES) break;
      if (dir.name === String(currentDeploymentId)) continue; // Don't evict what we're about to use

      const deploymentId = parseInt(dir.name, 10);
      if (isNaN(deploymentId)) continue;

      // Null out images.path for this deployment
      const depImages = await db
        .select()
        .from(images)
        .where(eq(images.deploymentId, deploymentId));

      for (const img of depImages) {
        if (img.path && img.path.includes("/cache/ct-images/")) {
          await db.update(images).set({ path: null }).where(eq(images.id, img.id));
        }
      }

      // Delete the directory
      await fs.rm(path.join(CACHE_BASE, dir.name), { recursive: true, force: true });
      totalSize -= dir.size;

      console.log(
        `[drive-downloader] Evicted cache for deployment ${deploymentId} (${(dir.size / 1024 / 1024).toFixed(1)} MB)`
      );
    }
  } catch {
    // Cache eviction is best-effort
  }
}
```

Call at the start of `downloadDeploymentForProcessing()`:

```typescript
await evictIfOverLimit(deploymentId);
```

#### Step 7: Add `.gitignore` entry

**File:** `.gitignore`

Add `data/cache/` to `.gitignore` (alongside existing `data/tmp/`, `data/thumbnails/`, etc.).

## Acceptance Criteria

- [x] Processing downloads to `data/cache/ct-images/{deploymentId}/` instead of `data/tmp/ct-job-{jobId}/`
- [x] Re-processing a deployment skips already-cached images (logged as "X cached, Y downloaded")
- [x] Image proxy serves full-size images from cache when `images.path` points to a valid file
- [x] Image proxy falls back to Drive API when cache file is missing (evicted or not yet cached)
- [x] Cache persists after processing (files NOT deleted on success)
- [x] `images.path` retains cache paths after processing (NOT cleared)
- [x] LRU eviction deletes oldest deployment cache when total cache exceeds `CT_IMAGE_CACHE_MAX_GB`
- [x] Eviction nulls out `images.path` for evicted deployment's images
- [x] `recoverStuckJobs()` does NOT delete cache directories (only temp dirs)
- [x] `cleanupJobTempDir()` only cleans legacy temp dirs, not cache dirs
- [x] `data/cache/` is in `.gitignore` (covered by existing `/data/` entry)
- [x] Docker volume mount (`./data:/app/data`) automatically persists cache (no changes needed)

## Dependencies & Risks

**Low risk:**
- No schema changes needed (`images.path` column already exists)
- No new dependencies
- Docker volume already covers `data/` (cache persists automatically)
- Fallback to Drive API on cache miss means degradation is graceful

**Edge cases to verify:**
- Deployment with 0 cached images (first run) -- should behave like current flow
- Eviction during processing -- `evictIfOverLimit` skips the current deployment
- Server restart -- `recoverStuckJobs()` leaves cache intact, only cleans temp dirs
- Concurrent processing of same deployment -- won't happen (queue is sequential)

## References

- Brainstorm: `docs/brainstorms/2026-02-14-camera-trap-image-caching-brainstorm.md`
- Drive downloader: `src/lib/drive-downloader.ts`
- Processing pipeline: `src/app/camera-trap/actions.ts:101-310`
- Image proxy: `src/app/api/ct-images/[id]/route.ts:172-208`
- Job recovery: `src/db/index.ts:136-198`
- Docker volume: `docker-compose.yml:10` (`./data:/app/data`)
- Learnings -- schema migrations: `docs/solutions/database-issues/missing-alter-table-migrations-push-schema.md`
