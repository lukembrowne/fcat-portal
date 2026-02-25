/**
 * Image Scanner Utility
 *
 * Scans directories for image files and optionally generates thumbnails.
 * Server-only module — never import in Client Components.
 */

import "server-only";

import { promises as fs } from "fs";
import path from "path";

const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".bmp",
  ".webp",
  ".tiff",
  ".tif",
]);

export interface ScannedImage {
  filename: string;
  path: string;
  size: number;
  modifiedAt: Date;
}

export interface ScanResult {
  success: boolean;
  images: ScannedImage[];
  totalFound: number;
  totalSize: number;
  error?: string;
}

export async function scanDirectoryForImages(
  dirPath: string,
  recursive: boolean = true
): Promise<ScanResult> {
  const images: ScannedImage[] = [];
  let totalSize = 0;

  try {
    const stat = await fs.stat(dirPath);
    if (!stat.isDirectory()) {
      return {
        success: false,
        images: [],
        totalFound: 0,
        totalSize: 0,
        error: `No es un directorio: ${dirPath}`,
      };
    }

    await scanDirectory(dirPath, images, recursive);
    totalSize = images.reduce((sum, img) => sum + img.size, 0);

    return {
      success: true,
      images,
      totalFound: images.length,
      totalSize,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Error desconocido";

    if (message.includes("ENOENT")) {
      return {
        success: false,
        images: [],
        totalFound: 0,
        totalSize: 0,
        error: `Directorio no encontrado: ${dirPath}`,
      };
    }
    if (message.includes("EACCES")) {
      return {
        success: false,
        images: [],
        totalFound: 0,
        totalSize: 0,
        error: `Permiso denegado: ${dirPath}`,
      };
    }

    return {
      success: false,
      images: [],
      totalFound: 0,
      totalSize: 0,
      error: message,
    };
  }
}

async function scanDirectory(
  dirPath: string,
  images: ScannedImage[],
  recursive: boolean
): Promise<void> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;

    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory() && recursive) {
      await scanDirectory(fullPath, images, recursive);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) {
        try {
          const stat = await fs.stat(fullPath);
          images.push({
            filename: entry.name,
            path: fullPath,
            size: stat.size,
            modifiedAt: stat.mtime,
          });
        } catch {
          // Skip files we can't stat
        }
      }
    }
  }
}

/**
 * Generate thumbnails for a list of images.
 * Resizes to 400px wide JPEG at 80% quality. Stores in
 * data/thumbnails/{deploymentId}/{filename}.jpg
 */
export async function generateThumbnails(
  scannedImages: ScannedImage[],
  deploymentId: number
): Promise<Map<string, string>> {
  const sharp = (await import("sharp")).default;

  const thumbnailDir = path.join(
    process.cwd(),
    "data",
    "thumbnails",
    String(deploymentId)
  );

  await fs.mkdir(thumbnailDir, { recursive: true });

  const results = new Map<string, string>();

  for (const img of scannedImages) {
    const thumbFilename =
      path.basename(img.filename, path.extname(img.filename)) + ".jpg";
    const thumbPath = path.join(thumbnailDir, thumbFilename);

    try {
      await sharp(img.path)
        .resize(400, null, { withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toFile(thumbPath);

      results.set(img.path, thumbPath);
    } catch {
      // Skip images that can't be thumbnailed
    }
  }

  return results;
}

// Re-export from client-safe module for backwards compatibility
export { formatBytes } from "./format";
