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
import { db } from "@/db";
import { images, videos } from "@/db/schema";
import { eq } from "drizzle-orm";
import { downloadDeploymentImages } from "./drive-client";
import {
  THUMBNAIL_DIR,
  THUMB_TIER,
  ANNOTATE_TIER,
  sizedPath,
  resizeForTier,
  evictDerivativesIfOverLimit,
} from "./thumbnail";
import { log } from "@/lib/log";
import { findBusyDeploymentIds } from "@/lib/job-locks";

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
 * Target bytes per chunk in chunked (disk-bounded) processing. Peak cache usage
 * during a chunked run is ≈ one chunk. An operator can lower this under disk
 * pressure without a redeploy.
 */
const CHUNK_TARGET_BYTES =
  parseInt(process.env.CT_PROCESS_CHUNK_MAX_GB || "10", 10) * 1024 * 1024 * 1024;
/** Assumed size for image rows whose `file_size` is null/0 when grouping chunks. */
const NULL_SIZE_FALLBACK_BYTES = 20 * 1024 * 1024;
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

/** A row from the `biochoco_images` table. */
export type ImageRow = typeof images.$inferSelect;

/**
 * Kill-switch for chunked (disk-bounded) processing. When false, deployments
 * that don't fit free disk fail cleanly via the Part A guard instead of being
 * chunked. Emergency lever only — flip to "false" without a redeploy if chunking
 * ever misbehaves in production.
 */
export const CHUNKING_ENABLED =
  (process.env.CT_PROCESS_CHUNKING_ENABLED ?? "true") !== "false";

/** Disposable derivative tiers warmed alongside the full-res download:
 * 400px thumb (grids) + 1920px annotate (annotation viewer). Both read from the
 * same in-memory full-res buffer, so a missing tier costs one extra resize. */
const DERIVATIVE_TIERS = [THUMB_TIER, ANNOTATE_TIER];

/**
 * Generate (and cache) image derivatives (thumb + annotate) for
 * already-downloaded full-res images. Shared by the bulk download and the
 * chunked loop. MUST run before any full-res file is released — derivatives are
 * resized from the full-res file on disk. Skips tiers already present, so
 * re-runs are cheap and existing thumbnails are never regenerated.
 */
async function generateThumbnails(
  deploymentId: number,
  entries: Array<{ imageId: number; localPath: string }>,
  onProgress?: (event: DownloadProgressEvent) => Promise<void>,
): Promise<void> {
  const derivDir = path.join(THUMBNAIL_DIR, String(deploymentId));
  await fs.mkdir(derivDir, { recursive: true });

  for (let i = 0; i < entries.length; i += THUMB_BATCH_SIZE) {
    const batch = entries.slice(i, i + THUMB_BATCH_SIZE);
    await Promise.all(
      batch.map(async ({ imageId, localPath }) => {
        // Determine which tiers are missing before reading the (large) source.
        const missing: Array<{ cachePath: string; tier: typeof THUMB_TIER }> = [];
        for (const tier of DERIVATIVE_TIERS) {
          const cachePath = sizedPath(tier, deploymentId, imageId);
          try {
            await fs.access(cachePath);
          } catch {
            missing.push({ cachePath, tier });
          }
        }
        if (missing.length === 0) return;
        try {
          const imgData = await fs.readFile(localPath);
          await Promise.all(
            missing.map(async ({ cachePath, tier }) => {
              const out = await resizeForTier(imgData, tier);
              await fs.writeFile(cachePath, out);
            }),
          );
        } catch (err) {
          log.warn(
            { err, imageId },
            "[drive-downloader] Derivative generation failed"
          );
        }
      })
    );
    if (onProgress) {
      await onProgress({
        phase: "thumbnails",
        generated: Math.min(i + THUMB_BATCH_SIZE, entries.length),
        total: entries.length,
      });
    }
  }
}

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

  // Generate thumbnails (shared helper — must run before any full-res release)
  const imagesWithPaths = driveImages.filter((img) => pathMap.has(img.driveFileId!));
  await generateThumbnails(
    deploymentId,
    imagesWithPaths.map((img) => ({
      imageId: img.id,
      localPath: pathMap.get(img.driveFileId!)!,
    })),
    onProgress
  );

  log.info(
    { jobId, generated: imagesWithPaths.length },
    "[drive-downloader] Thumbnails complete"
  );

  // Keep the derivative cache under its disk budget (LRU, skips this deployment).
  await evictDerivativesIfOverLimit(deploymentId);

  return { cacheDir, downloaded, skipped: alreadyCached.size, failed };
}

// ---------------------------------------------------------------------------
// Chunked (disk-bounded) processing primitives — used by the camera-trap runner
// when a deployment's pending download won't fit in free disk. See
// docs/plans/2026-05-26-fix-ml-chunked-download-plan.md.
// ---------------------------------------------------------------------------

/**
 * Estimate the not-yet-cached download size for a deployment's still images, to
 * decide bulk vs chunked. Read-only; mirrors the bulk download's image
 * selection (drive-backed, safe filename, under the per-file cap) and sums
 * bytes for files not already present in the cache (fallback for null sizes).
 */
export async function assessPendingStillDownload(deploymentId: number): Promise<{
  cacheDir: string;
  pendingBytes: number;
  driveImageCount: number;
}> {
  const cacheDir = path.join(CACHE_BASE, String(deploymentId));
  const deploymentImages = await db
    .select()
    .from(images)
    .where(eq(images.deploymentId, deploymentId));

  let pendingBytes = 0;
  let driveImageCount = 0;
  for (const img of deploymentImages) {
    if (!img.driveFileId) continue;
    if (!isSafeCacheFilename(cacheDir, img.filename)) continue;
    if ((img.fileSize ?? 0) > MAX_FILE_SIZE_BYTES) continue;
    driveImageCount++;
    const localPath = path.join(cacheDir, img.filename);
    try {
      await fs.access(localPath);
    } catch {
      pendingBytes += img.fileSize && img.fileSize > 0 ? img.fileSize : NULL_SIZE_FALLBACK_BYTES;
    }
  }
  return { cacheDir, pendingBytes, driveImageCount };
}

/**
 * Filter image rows to those safely downloadable into `cacheDir`: drive-backed,
 * safe filename, under the per-file size cap. Same predicate the bulk path uses.
 */
export function filterDownloadableRows(cacheDir: string, rows: ImageRow[]): ImageRow[] {
  return rows.filter(
    (img) =>
      !!img.driveFileId &&
      isSafeCacheFilename(cacheDir, img.filename) &&
      (img.fileSize ?? 0) <= MAX_FILE_SIZE_BYTES
  );
}

/**
 * Group image rows into chunks whose cumulative file size stays under
 * `chunkTargetBytes`. Rows with null/0 sizes use a fallback estimate. A single
 * file larger than the target gets its own chunk. Pure — unit-tested.
 */
export function groupRowsIntoChunks(
  rows: ImageRow[],
  chunkTargetBytes: number = CHUNK_TARGET_BYTES,
  nullSizeFallback: number = NULL_SIZE_FALLBACK_BYTES
): ImageRow[][] {
  const chunks: ImageRow[][] = [];
  let current: ImageRow[] = [];
  let acc = 0;
  for (const row of rows) {
    const size = row.fileSize && row.fileSize > 0 ? row.fileSize : nullSizeFallback;
    if (current.length > 0 && acc + size > chunkTargetBytes) {
      chunks.push(current);
      current = [];
      acc = 0;
    }
    current.push(row);
    acc += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Download a specific set of image rows into the cache: skip already-cached
 * files, download the rest, write images.path, and generate thumbnails (before
 * any release). Self-contained primitive shared by the chunked loop. Returns
 * the local paths that are now present on disk (for handing to the ML runner).
 *
 * NOTE: rows must be pre-filtered with filterDownloadableRows. No disk guard
 * here — bulk guards in downloadDeploymentForProcessing; chunked gates per chunk.
 */
export async function downloadImageSet(
  cacheDir: string,
  deploymentId: number,
  jobId: number,
  rows: ImageRow[],
  onProgress?: (event: DownloadProgressEvent) => Promise<void>,
  isCancelled?: () => Promise<boolean>
): Promise<{ downloaded: number; skipped: number; failed: number; localPaths: string[] }> {
  await fs.mkdir(cacheDir, { recursive: true });

  // Split into already-cached vs to-download by filesystem existence.
  const toDownload: Array<{
    id: string;
    name: string;
    size: number;
    modifiedTime: string;
    relativePath: string;
  }> = [];
  const alreadyCached = new Map<string, string>();
  for (const img of rows) {
    if (!img.driveFileId) continue;
    const localPath = path.join(cacheDir, img.filename);
    try {
      await fs.access(localPath);
      alreadyCached.set(img.driveFileId, localPath);
    } catch {
      toDownload.push({
        id: img.driveFileId,
        name: img.filename,
        size: img.fileSize || 0,
        modifiedTime: "",
        relativePath: img.filename,
      });
    }
  }

  if (onProgress) {
    await onProgress({ phase: "preflight", cached: alreadyCached.size, toDownload: toDownload.length });
  }

  let downloaded = 0;
  let failed = 0;
  const pathMap = new Map<string, string>();

  if (toDownload.length > 0) {
    const result = await downloadDeploymentImages(
      toDownload,
      cacheDir,
      (dl, fl, total) => {
        downloaded = dl;
        failed = fl;
        onProgress?.({ phase: "downloading", downloaded: dl, failed: fl, total });
      },
      isCancelled
    );
    downloaded = result.downloaded;
    failed = result.failed;
    for (const [fileId, localPath] of result.pathMap) pathMap.set(fileId, localPath);
  }
  for (const [fileId, localPath] of alreadyCached) pathMap.set(fileId, localPath);

  // Write cache paths into images.path
  for (const img of rows) {
    if (!img.driveFileId) continue;
    const localPath = pathMap.get(img.driveFileId);
    if (!localPath) continue;
    await db.update(images).set({ path: localPath }).where(eq(images.id, img.id));
  }

  // Thumbnails — MUST precede any release of full-res files.
  const withPaths = rows.filter((img) => img.driveFileId && pathMap.has(img.driveFileId));
  await generateThumbnails(
    deploymentId,
    withPaths.map((img) => ({ imageId: img.id, localPath: pathMap.get(img.driveFileId!)! })),
    onProgress
  );

  return {
    downloaded,
    skipped: alreadyCached.size,
    failed,
    localPaths: withPaths.map((img) => pathMap.get(img.driveFileId!)!),
  };
}

/**
 * After a chunk has been ML'd, delete its full-res cache files and null
 * images.path. Detections/identifications and thumbnails are kept; the image
 * proxy falls back to Drive via driveFileId. Non-atomic by design (unlink then
 * per-row DB update); recoverStuckJobs' existence-based path-nulling makes a
 * crash between the two safe on resume.
 */
export async function releaseChunkFiles(cacheDir: string, rows: ImageRow[]): Promise<void> {
  for (const img of rows) {
    const localPath = path.join(cacheDir, img.filename);
    try {
      await fs.unlink(localPath);
    } catch {
      // File may already be gone
    }
    await db.update(images).set({ path: null }).where(eq(images.id, img.id));
  }
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
export async function evictIfOverLimit(currentDeploymentId: number): Promise<void> {
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

/**
 * Reclaim orphaned `ct-images/{id}` directories — cache left behind by a
 * failed/cancelled run. Unlike `evictIfOverLimit`, this is NOT gated on the
 * cache cap (an orphan is reclaimable at any size because nothing is using it)
 * and it does NOT run at download time — it runs from the daily disk-maintenance
 * cron so a stuck job can never strand disk indefinitely.
 *
 * A directory is only deleted when its deployment has NO active/pending job
 * (camera-trap OR audio). For deleted dirs the matching `images.path` rows are
 * nulled so the image proxy falls back to Drive. Best-effort: never throws.
 */
export async function sweepOrphanedCache(): Promise<{
  removed: number;
  bytes: number;
  deployments: number[];
}> {
  const result = { removed: 0, bytes: 0, deployments: [] as number[] };
  let entries: string[];
  try {
    entries = await fs.readdir(CACHE_BASE);
  } catch {
    return result; // cache dir doesn't exist yet
  }

  // Resolve directory names to deployment IDs.
  const dirIds: number[] = [];
  for (const entry of entries) {
    const dirPath = path.join(CACHE_BASE, entry);
    let stat;
    try {
      stat = await fs.stat(dirPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const id = parseInt(entry, 10);
    if (Number.isNaN(id) || String(id) !== entry) continue; // skip non-id dirs
    dirIds.push(id);
  }
  if (dirIds.length === 0) return result;

  const busy = await findBusyDeploymentIds(dirIds);

  for (const id of dirIds) {
    if (busy.has(id)) continue; // active/pending job — never touch its cache

    const dirPath = path.join(CACHE_BASE, String(id));

    // Sum the directory size (for reporting) before deleting.
    let dirSize = 0;
    try {
      const files = await fs.readdir(dirPath);
      for (const file of files) {
        try {
          dirSize += (await fs.stat(path.join(dirPath, file))).size;
        } catch {
          // file vanished mid-scan
        }
      }
    } catch {
      continue;
    }

    // Null cache paths so the proxy falls back to Drive.
    try {
      const depImages = await db
        .select()
        .from(images)
        .where(eq(images.deploymentId, id));
      for (const img of depImages) {
        if (img.path && img.path.includes("/cache/ct-images/")) {
          await db
            .update(images)
            .set({ path: null })
            .where(eq(images.id, img.id));
        }
      }
    } catch {
      // If we can't null paths, skip deletion — don't leave dangling paths.
      continue;
    }

    try {
      await fs.rm(dirPath, { recursive: true, force: true });
    } catch {
      continue;
    }

    result.removed++;
    result.bytes += dirSize;
    result.deployments.push(id);
    log.info(
      { deploymentId: id, sizeMb: +(dirSize / 1024 / 1024).toFixed(1) },
      "[drive-downloader] Swept orphaned cache for deployment",
    );
  }

  return result;
}
