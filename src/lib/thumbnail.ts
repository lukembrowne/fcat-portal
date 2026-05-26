import path from "path";
import { promises as fs } from "fs";
import sharp from "sharp";

export const THUMBNAIL_DIR = path.join(process.cwd(), "data", "thumbnails");
export const THUMBNAIL_WIDTH = 400;
export const THUMBNAIL_QUALITY = 80;

/**
 * Total disk budget for the thumbnail cache. Thumbnails are cheap to keep
 * (~22 KB each) but the directory grows unbounded as deployments are processed,
 * so we cap it. Unlike the full-res cache, evicting a thumbnail only costs a
 * re-download + resize on next view (see getOrGenerateThumbnail), so a modest
 * cap is safe. Override with CT_THUMBNAIL_CACHE_MAX_GB.
 */
const THUMBNAIL_CACHE_MAX_BYTES =
  parseFloat(process.env.CT_THUMBNAIL_CACHE_MAX_GB || "5") * 1024 * 1024 * 1024;

/** Build the cache path for a thumbnail. */
export function thumbnailPath(deploymentId: number, imageId: number): string {
  return path.join(THUMBNAIL_DIR, String(deploymentId), `${imageId}.jpg`);
}

/** Delete a deployment's entire thumbnail directory. Best-effort. */
export async function deleteDeploymentThumbnails(
  deploymentId: number,
): Promise<void> {
  await fs.rm(path.join(THUMBNAIL_DIR, String(deploymentId)), {
    recursive: true,
    force: true,
  });
}

/**
 * Evict oldest thumbnail directories (deployment-level LRU by mtime) when the
 * cache exceeds THUMBNAIL_CACHE_MAX_BYTES. Skips the deployment passed in (the
 * one currently being processed) so freshly-generated thumbnails survive.
 * Evicted thumbnails regenerate on demand, so this is safe and best-effort.
 */
export async function evictThumbnailsIfOverLimit(
  skipDeploymentId?: number,
): Promise<void> {
  try {
    let entries: string[];
    try {
      entries = await fs.readdir(THUMBNAIL_DIR);
    } catch {
      return; // No thumbnails yet
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
    if (totalSize <= THUMBNAIL_CACHE_MAX_BYTES) return;

    // Oldest first
    dirStats.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());

    for (const dir of dirStats) {
      if (totalSize <= THUMBNAIL_CACHE_MAX_BYTES) break;
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
  const tp = thumbnailPath(deploymentId, imageId);

  // 1. Cache hit
  try {
    return await fs.readFile(tp);
  } catch { /* miss */ }

  // 2. Try local file
  if (localPath) {
    try {
      const data = await fs.readFile(localPath);
      return await generateAndCache(data, tp);
    } catch { /* fall through */ }
  }

  // 3. Try Drive
  if (!driveFileId) return null;
  const buffer = await downloadFn(driveFileId);
  return await generateAndCache(buffer, tp);
}

/** Resize to thumbnail, write to cache, return buffer. */
export async function generateAndCache(
  source: Buffer,
  cachePath: string,
): Promise<Buffer> {
  const thumb = await sharp(source)
    .resize(THUMBNAIL_WIDTH)
    .jpeg({ quality: THUMBNAIL_QUALITY })
    .toBuffer();
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, thumb);
  return thumb;
}
