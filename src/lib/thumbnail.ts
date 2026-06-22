import path from "path";
import { promises as fs } from "fs";
import sharp from "sharp";

export const THUMBNAIL_DIR = path.join(process.cwd(), "data", "thumbnails");
export const THUMBNAIL_WIDTH = 400;
export const THUMBNAIL_QUALITY = 80;

/**
 * Image derivative cache.
 *
 * Two on-the-fly-generated, disposable variants of each camera-trap original
 * live SIDE BY SIDE in one per-deployment directory under a single disk budget
 * and a single deployment-level LRU:
 *
 *   - thumb    (400px,  grid/gallery)        →  {deploymentId}/{imageId}.jpg
 *   - annotate (1920px, annotation viewer)   →  {deploymentId}/{imageId}@1920.jpg
 *
 * Both are cheap to regenerate (local resize if the full-res file is still on
 * disk, else one Drive download + resize), so eviction is safe and self-healing
 * — the next view regenerates whatever was dropped. Full-res serving and export
 * are unaffected; this cache holds only derivatives.
 */
export interface ImageSizeTier {
  /** Filename suffix before ".jpg". "" → {id}.jpg (back-compat thumb). */
  suffix: string;
  /** Long-edge bound in px. */
  longEdge: number;
  /** JPEG quality. */
  quality: number;
}

export const THUMB_TIER: ImageSizeTier = {
  suffix: "",
  longEdge: THUMBNAIL_WIDTH,
  quality: THUMBNAIL_QUALITY,
};

/** ~1920px / q80 ≈ a few hundred KB — sharp at fit-to-screen, ~35–40× smaller
 * than the ~19 MB originals. Served to the annotation viewer. */
export const ANNOTATE_TIER: ImageSizeTier = {
  suffix: "@1920",
  longEdge: 1920,
  quality: 80,
};

/**
 * Total disk budget for the unified derivative cache (thumbs + annotate).
 * Annotate variants dominate (~500 KB vs ~22 KB), so this is larger than the
 * old thumbnail-only cap. Evicting only costs a re-resize on next view, so a
 * modest cap is safe. Override with CT_DERIVATIVE_CACHE_MAX_GB (falls back to
 * the legacy CT_THUMBNAIL_CACHE_MAX_GB for back-compat).
 */
const DERIVATIVE_CACHE_MAX_BYTES =
  parseFloat(
    process.env.CT_DERIVATIVE_CACHE_MAX_GB ||
      process.env.CT_THUMBNAIL_CACHE_MAX_GB ||
      "15",
  ) *
  1024 *
  1024 *
  1024;

/** Build the cache path for a tier's variant of an image. */
export function sizedPath(
  tier: ImageSizeTier,
  deploymentId: number,
  imageId: number,
): string {
  return path.join(
    THUMBNAIL_DIR,
    String(deploymentId),
    `${imageId}${tier.suffix}.jpg`,
  );
}

/** Build the cache path for a thumbnail (back-compat — equals the thumb tier). */
export function thumbnailPath(deploymentId: number, imageId: number): string {
  return sizedPath(THUMB_TIER, deploymentId, imageId);
}

/** Resize a source buffer per tier. Thumb keeps the legacy width-only behavior
 * (so existing 400px thumbs stay byte-identical); annotate bounds the long edge
 * and never upscales small originals. */
export function resizeForTier(
  source: Buffer,
  tier: ImageSizeTier,
): Promise<Buffer> {
  const pipeline =
    tier === THUMB_TIER
      ? sharp(source).resize(tier.longEdge)
      : sharp(source).resize(tier.longEdge, tier.longEdge, {
          fit: "inside",
          withoutEnlargement: true,
        });
  return pipeline.jpeg({ quality: tier.quality }).toBuffer();
}

/** Delete a deployment's entire derivative directory (both tiers). Best-effort. */
export async function deleteDeploymentThumbnails(
  deploymentId: number,
): Promise<void> {
  await fs.rm(path.join(THUMBNAIL_DIR, String(deploymentId)), {
    recursive: true,
    force: true,
  });
}

/**
 * Evict oldest derivative directories (deployment-level LRU by mtime) when the
 * cache exceeds DERIVATIVE_CACHE_MAX_BYTES. Sums every file in each deployment
 * dir, so it accounts for both thumb and annotate variants. Skips the
 * deployment passed in (the one currently being processed). Evicted variants
 * regenerate on demand, so this is safe and best-effort.
 */
export async function evictDerivativesIfOverLimit(
  skipDeploymentId?: number,
): Promise<void> {
  try {
    let entries: string[];
    try {
      entries = await fs.readdir(THUMBNAIL_DIR);
    } catch {
      return; // No derivatives yet
    }

    const dirStats: Array<{ name: string; size: number; mtime: Date }> = [];
    for (const entry of entries) {
      const dirPath = path.join(THUMBNAIL_DIR, entry);
      let stat;
      try {
        stat = await fs.stat(dirPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      let dirSize = 0;
      const files = await fs.readdir(dirPath);
      for (const file of files) {
        try {
          dirSize += (await fs.stat(path.join(dirPath, file))).size;
        } catch {
          // File may have been removed
        }
      }
      dirStats.push({ name: entry, size: dirSize, mtime: stat.mtime });
    }

    let totalSize = dirStats.reduce((sum, d) => sum + d.size, 0);
    if (totalSize <= DERIVATIVE_CACHE_MAX_BYTES) return;

    // Oldest first
    dirStats.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());

    for (const dir of dirStats) {
      if (totalSize <= DERIVATIVE_CACHE_MAX_BYTES) break;
      if (dir.name === String(skipDeploymentId)) continue;

      await fs.rm(path.join(THUMBNAIL_DIR, dir.name), {
        recursive: true,
        force: true,
      });
      totalSize -= dir.size;
    }
  } catch {
    // Eviction is best-effort
  }
}

/** Back-compat alias — the cache is unified, so this evicts both tiers. */
export const evictThumbnailsIfOverLimit = evictDerivativesIfOverLimit;

/**
 * Throttled, fire-and-forget eviction for the lazy (proxy) generation path.
 * On-demand generation is the common case for deployments that weren't
 * pre-cached, and annotate files are ~20× thumbnails, so we keep the cache
 * bounded without scanning the whole dir on every request: run at most once
 * per LAZY_EVICT_INTERVAL_MS. Never awaited by the caller.
 */
const LAZY_EVICT_INTERVAL_MS = 5 * 60 * 1000;
let lastLazyEvictAt = 0;
export function maybeEvictDerivatives(): void {
  const now = Date.now();
  if (now - lastLazyEvictAt < LAZY_EVICT_INTERVAL_MS) return;
  lastLazyEvictAt = now;
  void evictDerivativesIfOverLimit();
}

/**
 * Get or generate a cached derivative for a tier.
 * Tries: cache hit -> local full-res file -> Drive download.
 * Returns the JPEG buffer, or null if no source available.
 */
export async function getOrGenerateSized(
  tier: ImageSizeTier,
  imageId: number,
  deploymentId: number,
  localPath: string | null,
  driveFileId: string | null,
  downloadFn: (fileId: string) => Promise<Buffer>,
): Promise<Buffer | null> {
  const cachePath = sizedPath(tier, deploymentId, imageId);

  // 1. Cache hit
  try {
    return await fs.readFile(cachePath);
  } catch {
    /* miss */
  }

  // 2. Try local full-res file
  if (localPath) {
    try {
      const data = await fs.readFile(localPath);
      return await generateAndCacheSized(data, cachePath, tier);
    } catch {
      /* fall through */
    }
  }

  // 3. Try Drive
  if (!driveFileId) return null;
  const buffer = await downloadFn(driveFileId);
  return await generateAndCacheSized(buffer, cachePath, tier);
}

/** Back-compat wrapper for thumbnail generation (the 400px tier). */
export function getOrGenerateThumbnail(
  imageId: number,
  deploymentId: number,
  localPath: string | null,
  driveFileId: string | null,
  downloadFn: (fileId: string) => Promise<Buffer>,
): Promise<Buffer | null> {
  return getOrGenerateSized(
    THUMB_TIER,
    imageId,
    deploymentId,
    localPath,
    driveFileId,
    downloadFn,
  );
}

/** Resize per tier, write to cache, return buffer. */
export async function generateAndCacheSized(
  source: Buffer,
  cachePath: string,
  tier: ImageSizeTier,
): Promise<Buffer> {
  const out = await resizeForTier(source, tier);
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, out);
  return out;
}

/** Back-compat: resize to the 400px thumbnail tier and cache. */
export function generateAndCache(
  source: Buffer,
  cachePath: string,
): Promise<Buffer> {
  return generateAndCacheSized(source, cachePath, THUMB_TIER);
}
