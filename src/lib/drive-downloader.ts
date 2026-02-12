/**
 * Drive Downloader — Downloads deployment images from Drive for ML processing.
 *
 * Downloads to data/tmp/ct-job-{jobId}/, writes temp paths into images.path,
 * and generates thumbnails during the download pass.
 *
 * Server-only module — never import in Client Components.
 */

import "server-only";

import { promises as fs } from "fs";
import path from "path";
import sharp from "sharp";
import { db } from "@/db";
import { images } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  listImagesRecursive,
  downloadDeploymentImages,
} from "./drive-client";

const TEMP_BASE = path.join(process.cwd(), "data", "tmp");
const THUMBNAIL_DIR = path.join(process.cwd(), "data", "thumbnails");
const THUMBNAIL_WIDTH = 400;
const THUMBNAIL_QUALITY = 80;

/**
 * Download all images for a deployment from Drive to a temp directory.
 * Also generates thumbnails during the download pass.
 *
 * Writes temp file paths into images.path so ML runner picks them up unchanged.
 */
export async function downloadDeploymentForProcessing(
  deploymentId: number,
  jobId: number,
  driveFolderId: string
): Promise<{ tempDir: string; downloaded: number; failed: number }> {
  const tempDir = path.join(TEMP_BASE, `ct-job-${jobId}`);
  await fs.mkdir(tempDir, { recursive: true });

  // Get all images for this deployment that have Drive file IDs
  const deploymentImages = await db
    .select()
    .from(images)
    .where(eq(images.deploymentId, deploymentId));

  const driveImages = deploymentImages.filter((img) => img.driveFileId);

  if (driveImages.length === 0) {
    return { tempDir, downloaded: 0, failed: 0 };
  }

  // Pre-flight: estimate required space
  const totalSize = driveImages.reduce((sum, img) => sum + (img.fileSize || 0), 0);
  console.log(
    `[drive-downloader] Downloading ${driveImages.length} images (~${(totalSize / 1024 / 1024).toFixed(1)} MB) for job ${jobId}`
  );

  // Map DB images to DriveImageFile format for downloadDeploymentImages
  const driveImageFiles = driveImages.map((img) => ({
    id: img.driveFileId!,
    name: img.filename,
    size: img.fileSize || 0,
    modifiedTime: "",
    relativePath: img.filename,
  }));

  const { downloaded, failed, pathMap } = await downloadDeploymentImages(
    driveImageFiles,
    tempDir
  );

  // Write temp paths into images.path and generate thumbnails
  const thumbDir = path.join(THUMBNAIL_DIR, String(deploymentId));
  await fs.mkdir(thumbDir, { recursive: true });

  for (const img of driveImages) {
    const localPath = pathMap.get(img.driveFileId!);
    if (!localPath) continue;

    // Write temp path so ML runner picks it up
    await db
      .update(images)
      .set({ path: localPath })
      .where(eq(images.id, img.id));

    // Generate thumbnail if it doesn't exist
    const thumbPath = path.join(thumbDir, `${img.id}.jpg`);
    try {
      await fs.access(thumbPath);
    } catch {
      // Thumbnail doesn't exist — generate from downloaded image
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
  }

  console.log(
    `[drive-downloader] Job ${jobId}: ${downloaded} downloaded, ${failed} failed`
  );

  return { tempDir, downloaded, failed };
}

/**
 * Clean up a temp directory and clear images.path for a job's images.
 */
export async function cleanupJobTempDir(
  jobId: number,
  tempDir?: string
): Promise<void> {
  // Clear images.path for all images linked to this job
  const jobImages = await db
    .select()
    .from(images)
    .where(eq(images.jobId, jobId));

  for (const img of jobImages) {
    if (img.path && img.path.startsWith(TEMP_BASE)) {
      await db
        .update(images)
        .set({ path: null })
        .where(eq(images.id, img.id));
    }
  }

  // Remove temp directory
  const dirToRemove = tempDir || path.join(TEMP_BASE, `ct-job-${jobId}`);
  try {
    await fs.rm(dirToRemove, { recursive: true, force: true });
    console.log(`[drive-downloader] Cleaned up ${dirToRemove}`);
  } catch {
    // Directory may not exist
  }
}

/**
 * Clean up any orphaned temp directories from interrupted jobs.
 * Called during server startup via recoverStuckJobs().
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
