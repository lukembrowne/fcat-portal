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
