# Camera Trap Image Caching

**Date:** 2026-02-14
**Status:** Brainstorm complete

## What We're Building

Replace the disposable temp directory (`data/tmp/ct-job-{jobId}/`) with a persistent per-deployment image cache (`data/cache/ct-images/{deploymentId}/`). Images downloaded from Google Drive stay cached for ML processing, annotation viewing, and re-processing. LRU eviction keeps disk usage under a configurable limit.

Three use cases solved by one mechanism:
1. **Re-processing** — re-running ML with updated models skips the download entirely
2. **Annotation speed** — full-size images served from disk instead of Drive API per request
3. **First processing** — images stay cached for immediate annotation after ML completes

## Why This Approach

**Chosen: Download directly to persistent cache (Approach A)**

Instead of downloading to a temp dir and deleting after processing, download to a cache dir and keep the files. The ML runner reads from the cache, the image proxy serves from the cache, and re-processing checks the cache before downloading.

**Rejected alternatives:**
- **Move temp to cache after processing (B):** Extra I/O on rename, no caching benefit if ML fails, proxy can't use cache during processing
- **Proxy-only caching (C):** Doesn't solve re-processing (the biggest pain point), cache builds slowly one image at a time

## Key Decisions

1. **Cache directory:** `data/cache/ct-images/{deploymentId}/` — organized per deployment (not per job), so re-processing reuses the same cache.

2. **Download with skip:** Before downloading each image, check if it already exists in the cache dir. Skip if present. This makes re-processing near-instant.

3. **Keep `images.path` in DB:** After processing, leave the cache paths in `images.path` instead of clearing them. The image proxy serves from `images.path` first, falls back to Drive API only if path is null or file is missing.

4. **No cleanup after processing:** `cleanupJobTempDir()` becomes a no-op for cached deployments. Cache persists across jobs.

5. **LRU eviction at deployment level:** Before each download batch, check total cache size. If over limit (`CT_IMAGE_CACHE_MAX_GB` env var, default 30 GB), delete the oldest deployment cache (by directory mtime). Also null out `images.path` for that deployment so the proxy falls back to Drive.

6. **No cache invalidation:** Camera trap photos rarely change after upload. Not worth the complexity.

7. **Scale context:** Typical deployments are <500 images, ~1-1.5 GB each. 10-30 active deployments = 10-45 GB. VPS has ~125 GB free. A 30 GB default cache limit comfortably holds 20-30 deployments.

## Architecture

```
data/
  cache/
    ct-images/
      {deploymentId}/      ← persistent full-size images
        IMG_001.jpg
        IMG_002.jpg
  thumbnails/              ← unchanged, already persistent
    {deploymentId}/
      {imageId}.jpg
  tmp/                     ← only for non-Drive edge cases
```

### Processing Flow

```
User clicks "Procesar"
  → downloadDeploymentForProcessing()
    → Check data/cache/ct-images/{deploymentId}/
    → Skip images that exist, download missing ones from Drive
    → Write cache paths into images.path
  → ML runner reads from images.path (cache dir)
  → Processing completes
  → DO NOT delete cache or clear images.path
  → Cache persists for proxy and re-processing
```

### Image Proxy Flow

```
GET /api/ct-images/{id}?size=full
  → Read images.path from DB
  → If path exists and file exists → serve from disk (cache hit)
  → If path null or file missing → download from Drive API (cache miss)
```

### Eviction Flow

```
Before download batch:
  → Calculate total size of data/cache/ct-images/
  → If > CT_IMAGE_CACHE_MAX_GB:
    → Find oldest deployment dir (by mtime)
    → Delete it
    → NULL out images.path for that deployment
    → Repeat until under limit
```

## Files to Change

| File | Change |
|------|--------|
| `src/lib/drive-downloader.ts` | Download to cache dir, skip existing files, remove cleanup logic |
| `src/app/camera-trap/actions.ts` | Remove `cleanupJobTempDir()` call after processing |
| `src/app/api/ct-images/[id]/route.ts` | Check `images.path` before Drive API for full images |
| `src/db/index.ts` | Update `recoverStuckJobs()` to not clean cache dirs |

## Open Questions

- Should there be a UI element showing cache status/size per deployment? (Probably not needed for V1)
- Should the image proxy also write to cache on a cache miss? (Nice to have but not critical — most images get cached during processing anyway)
