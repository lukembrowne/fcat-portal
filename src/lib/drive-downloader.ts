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
import {
  THUMBNAIL_DIR,
  THUMBNAIL_WIDTH,
  THUMBNAIL_QUALITY,
  thumbnailPath,
  evictThumbnailsIfOverLimit,
} from "./thumbnail";
import { log } from "@/lib/log";

const TEMP_BASE = path.join(process.cwd(), "data", "tmp");
const CACHE_BASE = path.join(process.cwd(), "data", "cache", "ct-images");
const THUMB_BATCH_SIZE = 20;
const CT_CACHE_MAX_BYTES =
  parseInt(process.env.CT_IMAGE_CACHE_MAX_GB || "30", 10) * 1024 * 1024 * 1024;
/**
 * Free-disk headroom required before we let a deployment download proceed. The
 * 2026-05-25 outage filled the shared 193 GB root disk (downloading 81 GB up
 * front) and crash-looped the box plus every co-tenant container. This margin
 * protects them; don't shrink it casually.
 */
const DISK_MARGIN_BYTES =
  parseInt(process.env.CT_PROCESS_DISK_MARGIN_GB || "20", 10) * 1024 * 1024 * 1024;
/**
 * Per-file size cap for anything we download into the cache. Anything larger
 * is rejected during preflight rather than allowed to consume the cache.
 * Camera-trap stills are typically 1–10 MB; 100 MB is a generous ceiling that
 * still rules out accidental video uploads or corrupt mega-files.
 */
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;
/**
 * Per-file size cap for videos. Camera-trap clips are typically 5–60 MB but
 * can run longer at higher framerates; 2 GB is the safety ceiling.
 */
const MAX_VIDEO_SIZE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Reject filenames that would escape the deployment cache directory via path
 * traversal, absolute paths, or unexpected separators. Returns true if the
 * filename is safe to join onto cacheDir.
 */
function isSafeCacheFilename(cacheDir: string, filename: string): boolean {
  if (!filename || filename.includes("\0")) return false;
  if (path.isAbsolute(filename)) return false;
  // Disallow any directory components — Drive filenames should be flat.
  if (filename.includes("/") || filename.includes("\\")) return false;
  if (filename === "." || filename === "..") return false;
  const resolved = path.resolve(cacheDir, filename);
  const cacheResolved = path.resolve(cacheDir);
  return (
    resolved === path.join(cacheResolved, filename) &&
    resolved.startsWith(cacheResolved + path.sep)
  );
}

export type DownloadProgressEvent =
  | { phase: "preflight"; cached: number; toDownload: number }
  | { phase: "downloading"; downloaded: number; failed: number; total: number }
  | { phase: "thumbnails"; generated: number; total: number };

/**
 * Free bytes on the filesystem holding the image cache, or `null` if it cannot
 * be measured. `data/` is a host bind-mount on the root fs and `process.cwd()`
 * is on that same fs, so statfs of cwd reflects the cache's filesystem. (Revisit
 * — statfs the cache path — if `data/` is ever moved to a separate volume.)
 *
 * FAIL-CLOSED: a `null` return must NEVER be treated as "plenty of room".
 * Callers treat unmeasurable disk as "do not risk an unbounded bulk download",
 * because permitting a bulk download on a measurement glitch is exactly the
 * branch that recreated the outage.
 */
export async function getFreeDiskBytes(): Promise<number | null> {
  try {
    const s = await fs.statfs(process.cwd());
    return s.bavail * s.bsize;
  } catch (err) {
    log.warn({ err }, "[drive-downloader] statfs failed — treating disk as unmeasurable");
    return null;
  }
}

/**
 * Pure capacity check: does `pendingBytes` fit in `freeBytes` while preserving
 * `marginBytes` of headroom? Unit-tested in isolation.
 */
export function diskFits(
  pendingBytes: number,
  freeBytes: number,
  marginBytes: number = DISK_MARGIN_BYTES,
): boolean {
  return pendingBytes + marginBytes <= freeBytes;
}

/**
 * Thrown when a deployment's pending download (or a single chunk) cannot fit in
 * free disk with the safety margin. The runner's outer catch turns this into a
 * clean `failed` job + `scanned` deployment instead of an ENOSPC server crash.
 */
export class InsufficientDiskError extends Error {
  constructor(pendingBytes: number, freeBytes: number, marginBytes: number = DISK_MARGIN_BYTES) {
    const gb = (b: number) => (b / 1024 / 1024 / 1024).toFixed(1);
    super(
      `Espacio en disco insuficiente: la descarga requiere ~${gb(pendingBytes)} GB ` +
        `pero solo hay ~${gb(freeBytes)} GB libres (margen ${gb(marginBytes)} GB). ` +
        `Procese menos imágenes o amplíe el disco.`,
    );
    this.name = "InsufficientDiskError";
  }
}

/**
 * Download all images for a deployment from Drive to a persistent cache directory.
 * Skips images that already exist in cache. Also generates thumbnails.
 *
 * Writes cache file paths into images.path so ML runner and image proxy use them.
 */
export async function downloadDeploymentForProcessing(
  deploymentId: number,
  jobId: number,
  onProgress?: (event: DownloadProgressEvent) => Promise<void>,
  isCancelled?: () => Promise<boolean>,
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

  let rejectedUnsafe = 0;
  let rejectedTooLarge = 0;
  for (const img of driveImages) {
    if (!isSafeCacheFilename(cacheDir, img.filename)) {
      log.warn(
        { imageId: img.id, filename: img.filename },
        "[drive-downloader] Skipping image — unsafe filename"
      );
      rejectedUnsafe++;
      continue;
    }
    if ((img.fileSize ?? 0) > MAX_FILE_SIZE_BYTES) {
      log.warn(
        {
          imageId: img.id,
          filename: img.filename,
          sizeMb: +((img.fileSize ?? 0) / 1024 / 1024).toFixed(1),
          capMb: MAX_FILE_SIZE_BYTES / 1024 / 1024,
        },
        "[drive-downloader] Skipping image — exceeds size cap"
      );
      rejectedTooLarge++;
      continue;
    }
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
  if (rejectedUnsafe > 0 || rejectedTooLarge > 0) {
    log.warn(
      { jobId, deploymentId, rejectedUnsafe, rejectedTooLarge },
      "[drive-downloader] Rejected unsafe/oversized files"
    );
  }

  // Pre-flight: estimate download size and report
  const downloadSize = toDownload.reduce((sum, f) => sum + f.size, 0);
  log.info(
    {
      jobId,
      deploymentId,
      cached: alreadyCached.size,
      toDownload: toDownload.length,
      downloadSizeMb: +(downloadSize / 1024 / 1024).toFixed(1),
    },
    "[drive-downloader] Pre-flight summary"
  );

  if (onProgress) {
    await onProgress({ phase: "preflight", cached: alreadyCached.size, toDownload: toDownload.length });
  }

  // Disk guard: refuse to start a download that would push the shared root
  // filesystem toward 100%. Fail-closed when disk is unmeasurable. The runner's
  // outer catch converts the throw into a clean failed job (no server crash).
  if (downloadSize > 0) {
    const freeBytes = await getFreeDiskBytes();
    if (freeBytes === null || !diskFits(downloadSize, freeBytes)) {
      throw new InsufficientDiskError(downloadSize, freeBytes ?? 0);
    }
  }

  // Download only missing images
  let downloaded = 0;
  let failed = 0;
  const pathMap = new Map<string, string>();
  const downloadStart = Date.now();

  if (toDownload.length > 0) {
    const result = await downloadDeploymentImages(toDownload, cacheDir, (dl, fl, total) => {
      downloaded = dl;
      failed = fl;
      onProgress?.({ phase: "downloading", downloaded: dl, failed: fl, total });
    }, isCancelled);
    downloaded = result.downloaded;
    failed = result.failed;
    for (const [fileId, localPath] of result.pathMap) {
      pathMap.set(fileId, localPath);
    }

    const dlSec = ((Date.now() - downloadStart) / 1000).toFixed(1);
    log.info(
      { jobId, downloaded, failed, dlSec },
      "[drive-downloader] Download complete"
    );
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
        const tp = thumbnailPath(deploymentId, img.id);
        try {
          await fs.access(tp);
        } catch {
          // Thumbnail doesn't exist — generate from downloaded/cached image
          try {
            const imgData = await fs.readFile(localPath);
            const thumb = await sharp(imgData)
              .resize(THUMBNAIL_WIDTH)
              .jpeg({ quality: THUMBNAIL_QUALITY })
              .toBuffer();
            await fs.writeFile(tp, thumb);
          } catch (err) {
            log.warn(
              { err, imageId: img.id },
              "[drive-downloader] Thumbnail generation failed"
            );
          }
        }
      })
    );
    if (onProgress) {
      await onProgress({
        phase: "thumbnails",
        generated: Math.min(i + THUMB_BATCH_SIZE, imagesWithPaths.length),
        total: imagesWithPaths.length,
      });
    }
  }

  log.info(
    { jobId, generated: imagesWithPaths.length },
    "[drive-downloader] Thumbnails complete"
  );

  // Keep the thumbnail cache under its disk budget (LRU, skips this deployment).
  await evictThumbnailsIfOverLimit(deploymentId);

  return { cacheDir, downloaded, skipped: alreadyCached.size, failed };
}

/**
 * Download all videos for a deployment from Drive to a persistent cache directory.
 * Skips videos that already exist in cache. Writes cache paths into videos.path.
 */
export async function downloadVideosForProcessing(
  deploymentId: number,
  jobId: number,
  onProgress?: (event: DownloadProgressEvent) => Promise<void>,
  isCancelled?: () => Promise<boolean>,
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

  let rejectedUnsafe = 0;
  let rejectedTooLarge = 0;
  for (const vid of driveVideos) {
    if (!isSafeCacheFilename(cacheDir, vid.filename)) {
      log.warn(
        { videoId: vid.id, filename: vid.filename },
        "[drive-downloader] Skipping video — unsafe filename"
      );
      rejectedUnsafe++;
      continue;
    }
    if ((vid.fileSize ?? 0) > MAX_VIDEO_SIZE_BYTES) {
      log.warn(
        {
          videoId: vid.id,
          filename: vid.filename,
          sizeMb: +((vid.fileSize ?? 0) / 1024 / 1024).toFixed(1),
          capMb: MAX_VIDEO_SIZE_BYTES / 1024 / 1024,
        },
        "[drive-downloader] Skipping video — exceeds size cap"
      );
      rejectedTooLarge++;
      continue;
    }
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
  if (rejectedUnsafe > 0 || rejectedTooLarge > 0) {
    log.warn(
      { jobId, deploymentId, rejectedUnsafe, rejectedTooLarge },
      "[drive-downloader] Videos: rejected unsafe/oversized files"
    );
  }

  const downloadSize = toDownload.reduce((sum, f) => sum + f.size, 0);
  log.info(
    {
      jobId,
      deploymentId,
      cached: alreadyCached.size,
      toDownload: toDownload.length,
      downloadSizeMb: +(downloadSize / 1024 / 1024).toFixed(1),
    },
    "[drive-downloader] Videos: pre-flight summary"
  );

  if (onProgress) {
    await onProgress({ phase: "preflight", cached: alreadyCached.size, toDownload: toDownload.length });
  }

  // Disk guard (same as images): videos are larger per-file, so an unguarded
  // bulk video download can fill the shared disk too. Fail-closed.
  if (downloadSize > 0) {
    const freeBytes = await getFreeDiskBytes();
    if (freeBytes === null || !diskFits(downloadSize, freeBytes)) {
      throw new InsufficientDiskError(downloadSize, freeBytes ?? 0);
    }
  }

  // Download missing videos (lower parallelism — videos are larger)
  let downloaded = 0;
  let failed = 0;
  const pathMap = new Map<string, string>();

  if (toDownload.length > 0) {
    const result = await downloadDeploymentImages(toDownload, cacheDir, (dl, fl, total) => {
      downloaded = dl;
      failed = fl;
      onProgress?.({ phase: "downloading", downloaded: dl, failed: fl, total });
    }, isCancelled);
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
  for (const vid of driveVideos) {
    const localPath = pathMap.get(vid.driveFileId!);
    if (!localPath) continue;

    await db
      .update(videos)
      .set({ path: localPath })
      .where(eq(videos.id, vid.id));
  }

  log.info(
    { jobId, cached: alreadyCached.size, downloaded, failed },
    "[drive-downloader] Videos complete"
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
      log.info({ dirToRemove }, "[drive-downloader] Cleaned up");
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
        log.info({ dirPath }, "[drive-downloader] Cleaned up orphaned dir");
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

      log.info(
        { deploymentId, sizeMb: +(dir.size / 1024 / 1024).toFixed(1) },
        "[drive-downloader] Evicted cache for deployment"
      );
    }
  } catch {
    // Cache eviction is best-effort
  }
}
