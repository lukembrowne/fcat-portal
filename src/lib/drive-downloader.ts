/**
 * Drive Downloader — Downloads deployment images from Drive for ML processing.
 *
 * Downloads to data/cache/ct-images/{deploymentId}/ with persistent caching.
 * Skips images already in cache. Writes cache paths into images.path so
 * both the ML runner and image proxy can use them.
 *
 * LRU eviction at the deployment level keeps total cache under CT_IMAGE_CACHE_MAX_GB.
 *
 * Server-only module — never import in Client Components.
 */

import "server-only";

import { promises as fs } from "fs";
import path from "path";
import sharp from "sharp";
import { db } from "@/db";
import { images, videos } from "@/db/schema";
import { eq } from "drizzle-orm";
import { downloadDeploymentImages } from "./drive-client";

const TEMP_BASE = path.join(process.cwd(), "data", "tmp");
const CACHE_BASE = path.join(process.cwd(), "data", "cache", "ct-images");
const THUMBNAIL_DIR = path.join(process.cwd(), "data", "thumbnails");
const THUMBNAIL_WIDTH = 400;
const THUMBNAIL_QUALITY = 80;
const THUMB_BATCH_SIZE = 20;
const CT_CACHE_MAX_BYTES =
  parseInt(process.env.CT_IMAGE_CACHE_MAX_GB || "30", 10) * 1024 * 1024 * 1024;

/**
 * Download all images for a deployment from Drive to a persistent cache directory.
 * Skips images that already exist in cache. Also generates thumbnails.
 *
 * Writes cache file paths into images.path so ML runner and image proxy use them.
 */
export async function downloadDeploymentForProcessing(
  deploymentId: number,
  jobId: number,
  onProgress?: (downloaded: number, total: number) => Promise<void>
): Promise<{
  cacheDir: string;
  downloaded: number;
  skipped: number;
  failed: number;
}> {
  // Evict oldest cached deployments if over size limit
  await evictIfOverLimit(deploymentId);

  const cacheDir = path.join(CACHE_BASE, String(deploymentId));
  await fs.mkdir(cacheDir, { recursive: true });

  // Get all images for this deployment that have Drive file IDs
  const deploymentImages = await db
    .select()
    .from(images)
    .where(eq(images.deploymentId, deploymentId));

  const driveImages = deploymentImages.filter((img) => img.driveFileId);

  if (driveImages.length === 0) {
    return { cacheDir, downloaded: 0, skipped: 0, failed: 0 };
  }

  // Check which images are already cached
  const toDownload: Array<{
    id: string;
    name: string;
    size: number;
    modifiedTime: string;
    relativePath: string;
  }> = [];
  const alreadyCached = new Map<string, string>(); // driveFileId → local path

  for (const img of driveImages) {
    const localPath = path.join(cacheDir, img.filename);
    try {
      await fs.access(localPath);
      alreadyCached.set(img.driveFileId!, localPath);
    } catch {
      toDownload.push({
        id: img.driveFileId!,
        name: img.filename,
        size: img.fileSize || 0,
        modifiedTime: "",
        relativePath: img.filename,
      });
    }
  }

  // Pre-flight: estimate download size
  const downloadSize = toDownload.reduce((sum, f) => sum + f.size, 0);
  console.log(
    `[drive-downloader] Job ${jobId}: ${alreadyCached.size} cached, ${toDownload.length} to download (~${(downloadSize / 1024 / 1024).toFixed(1)} MB)`
  );

  // Download only missing images
  let downloaded = 0;
  let failed = 0;
  const pathMap = new Map<string, string>();

  if (toDownload.length > 0) {
    const result = await downloadDeploymentImages(toDownload, cacheDir);
    downloaded = result.downloaded;
    failed = result.failed;
    for (const [fileId, localPath] of result.pathMap) {
      pathMap.set(fileId, localPath);
    }
  }

  // Merge cached paths into the map
  for (const [fileId, localPath] of alreadyCached) {
    pathMap.set(fileId, localPath);
  }

  // Write cache paths into images.path
  for (const img of driveImages) {
    const localPath = pathMap.get(img.driveFileId!);
    if (!localPath) continue;

    await db
      .update(images)
      .set({ path: localPath })
      .where(eq(images.id, img.id));
  }

  // Generate thumbnails in batches of THUMB_BATCH_SIZE
  const thumbDir = path.join(THUMBNAIL_DIR, String(deploymentId));
  await fs.mkdir(thumbDir, { recursive: true });

  const imagesWithPaths = driveImages.filter((img) => pathMap.has(img.driveFileId!));

  for (let i = 0; i < imagesWithPaths.length; i += THUMB_BATCH_SIZE) {
    const batch = imagesWithPaths.slice(i, i + THUMB_BATCH_SIZE);
    await Promise.all(
      batch.map(async (img) => {
        const localPath = pathMap.get(img.driveFileId!)!;
        const thumbPath = path.join(thumbDir, `${img.id}.jpg`);
        try {
          await fs.access(thumbPath);
        } catch {
          // Thumbnail doesn't exist — generate from downloaded/cached image
          try {
            const imgData = await fs.readFile(localPath);
            const thumb = await sharp(imgData)
              .resize(THUMBNAIL_WIDTH)
              .jpeg({ quality: THUMBNAIL_QUALITY })
              .toBuffer();
            await fs.writeFile(thumbPath, thumb);
          } catch (err) {
            console.warn(
              `[drive-downloader] Thumbnail generation failed for image ${img.id}:`,
              err instanceof Error ? err.message : err
            );
          }
        }
      })
    );
    if (onProgress) {
      await onProgress(
        Math.min(i + THUMB_BATCH_SIZE, imagesWithPaths.length),
        imagesWithPaths.length
      );
    }
  }

  console.log(
    `[drive-downloader] Job ${jobId}: ${alreadyCached.size} cached, ${downloaded} downloaded, ${failed} failed`
  );

  return { cacheDir, downloaded, skipped: alreadyCached.size, failed };
}

/**
 * Download all videos for a deployment from Drive to a persistent cache directory.
 * Skips videos that already exist in cache. Writes cache paths into videos.path.
 */
export async function downloadVideosForProcessing(
  deploymentId: number,
  jobId: number,
  onProgress?: (downloaded: number, total: number) => Promise<void>
): Promise<{
  cacheDir: string;
  downloaded: number;
  skipped: number;
  failed: number;
}> {
  const cacheDir = path.join(CACHE_BASE, String(deploymentId));
  await fs.mkdir(cacheDir, { recursive: true });

  // Get all videos for this deployment that have Drive file IDs
  const deploymentVideos = await db
    .select()
    .from(videos)
    .where(eq(videos.deploymentId, deploymentId));

  const driveVideos = deploymentVideos.filter((v) => v.driveFileId);

  if (driveVideos.length === 0) {
    return { cacheDir, downloaded: 0, skipped: 0, failed: 0 };
  }

  // Check which videos are already cached
  const toDownload: Array<{
    id: string;
    name: string;
    size: number;
    modifiedTime: string;
    relativePath: string;
  }> = [];
  const alreadyCached = new Map<string, string>();

  for (const vid of driveVideos) {
    const localPath = path.join(cacheDir, vid.filename);
    try {
      await fs.access(localPath);
      alreadyCached.set(vid.driveFileId!, localPath);
    } catch {
      toDownload.push({
        id: vid.driveFileId!,
        name: vid.filename,
        size: vid.fileSize || 0,
        modifiedTime: "",
        relativePath: vid.filename,
      });
    }
  }

  const downloadSize = toDownload.reduce((sum, f) => sum + f.size, 0);
  console.log(
    `[drive-downloader] Job ${jobId} videos: ${alreadyCached.size} cached, ${toDownload.length} to download (~${(downloadSize / 1024 / 1024).toFixed(1)} MB)`
  );

  // Download missing videos (lower parallelism — videos are larger)
  let downloaded = 0;
  let failed = 0;
  const pathMap = new Map<string, string>();

  if (toDownload.length > 0) {
    const result = await downloadDeploymentImages(toDownload, cacheDir);
    downloaded = result.downloaded;
    failed = result.failed;
    for (const [fileId, localPath] of result.pathMap) {
      pathMap.set(fileId, localPath);
    }
  }

  // Merge cached paths
  for (const [fileId, localPath] of alreadyCached) {
    pathMap.set(fileId, localPath);
  }

  // Write cache paths into videos.path
  let progressCount = 0;
  for (const vid of driveVideos) {
    const localPath = pathMap.get(vid.driveFileId!);
    if (!localPath) continue;

    await db
      .update(videos)
      .set({ path: localPath })
      .where(eq(videos.id, vid.id));

    progressCount++;
    if (onProgress) {
      await onProgress(progressCount, driveVideos.length);
    }
  }

  console.log(
    `[drive-downloader] Job ${jobId} videos: ${alreadyCached.size} cached, ${downloaded} downloaded, ${failed} failed`
  );

  return { cacheDir, downloaded, skipped: alreadyCached.size, failed };
}

/**
 * Clean up a temp directory and clear images.path for a job's images.
 * Only cleans legacy temp dirs (data/tmp/), never cache dirs (data/cache/).
 */
export async function cleanupJobTempDir(
  jobId: number,
  tempDir?: string
): Promise<void> {
  // Clear images.path only for images with temp (non-cache) paths
  const jobImages = await db
    .select()
    .from(images)
    .where(eq(images.jobId, jobId));

  for (const img of jobImages) {
    if (img.path && img.path.includes("/tmp/ct-job-")) {
      await db
        .update(images)
        .set({ path: null })
        .where(eq(images.id, img.id));
    }
  }

  // Only remove temp directories, not cache directories
  const dirToRemove = tempDir || path.join(TEMP_BASE, `ct-job-${jobId}`);
  if (dirToRemove.includes("/tmp/")) {
    try {
      await fs.rm(dirToRemove, { recursive: true, force: true });
      console.log(`[drive-downloader] Cleaned up ${dirToRemove}`);
    } catch {
      // Directory may not exist
    }
  }
}

/**
 * Clean up any orphaned temp directories from interrupted jobs.
 * Called during server startup via recoverStuckJobs().
 * Does NOT touch cache directories.
 */
export async function cleanupOrphanedTempDirs(): Promise<void> {
  try {
    const entries = await fs.readdir(TEMP_BASE);
    for (const entry of entries) {
      if (entry.startsWith("ct-job-")) {
        const dirPath = path.join(TEMP_BASE, entry);
        await fs.rm(dirPath, { recursive: true, force: true });
        console.log(`[drive-downloader] Cleaned up orphaned ${dirPath}`);
      }
    }
  } catch {
    // TEMP_BASE may not exist
  }
}

/**
 * Evict oldest cached deployment directories when total cache exceeds the limit.
 * Skips the deployment currently being processed.
 * Nulls out images.path for evicted deployments so the proxy falls back to Drive.
 */
async function evictIfOverLimit(currentDeploymentId: number): Promise<void> {
  try {
    let entries: string[];
    try {
      entries = await fs.readdir(CACHE_BASE);
    } catch {
      return; // Cache directory doesn't exist yet
    }

    const dirStats: Array<{ name: string; size: number; mtime: Date }> = [];

    for (const entry of entries) {
      const dirPath = path.join(CACHE_BASE, entry);
      const stat = await fs.stat(dirPath);
      if (!stat.isDirectory()) continue;

      // Calculate directory size
      let dirSize = 0;
      const files = await fs.readdir(dirPath);
      for (const file of files) {
        try {
          const fileStat = await fs.stat(path.join(dirPath, file));
          dirSize += fileStat.size;
        } catch {
          // File may have been removed
        }
      }

      dirStats.push({ name: entry, size: dirSize, mtime: stat.mtime });
    }

    let totalSize = dirStats.reduce((sum, d) => sum + d.size, 0);

    if (totalSize <= CT_CACHE_MAX_BYTES) return;

    // Sort by mtime ascending (oldest first)
    dirStats.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());

    // Evict oldest until under limit
    for (const dir of dirStats) {
      if (totalSize <= CT_CACHE_MAX_BYTES) break;
      if (dir.name === String(currentDeploymentId)) continue;

      const deploymentId = parseInt(dir.name, 10);
      if (isNaN(deploymentId)) continue;

      // Null out images.path for this deployment
      const depImages = await db
        .select()
        .from(images)
        .where(eq(images.deploymentId, deploymentId));

      for (const img of depImages) {
        if (img.path && img.path.includes("/cache/ct-images/")) {
          await db
            .update(images)
            .set({ path: null })
            .where(eq(images.id, img.id));
        }
      }

      // Delete the directory
      await fs.rm(path.join(CACHE_BASE, dir.name), {
        recursive: true,
        force: true,
      });
      totalSize -= dir.size;

      console.log(
        `[drive-downloader] Evicted cache for deployment ${deploymentId} (${(dir.size / 1024 / 1024).toFixed(1)} MB)`
      );
    }
  } catch {
    // Cache eviction is best-effort
  }
}
