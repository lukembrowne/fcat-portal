/**
 * External-frame cache: the on-disk store for downloaded LILA frames.
 *
 * `data/external/<dataset>/<stem>.jpg` is a REGENERABLE cache, not durable
 * storage. The durable truth lives in the DB (`images.path`,
 * `external_images.sourceUrl`, detections, verified identifications); a frame
 * file can be cleared to reclaim disk and re-downloaded on demand from its
 * `sourceUrl`. `downloadExternalFrame` is the single way a frame lands on disk,
 * shared by the import job (pre-warm) and the training-export step (lazy
 * re-download on a cache miss), so a re-fetched frame is byte-identical to the
 * imported one (same EXIF scrub + jpeg encode).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import pLimit from "p-limit";

/** Where downloaded external frames are cached on the droplet. */
export const EXTERNAL_DIR = path.join(process.cwd(), "data", "external");

/**
 * Fetch a frame URL, strip EXIF via a sharp re-encode, and write it to
 * `destPath` (creating parent dirs). Throws on a non-OK response so callers can
 * tally the failure. The jpeg quality matches the import path so re-downloaded
 * frames reproduce the original cache entry exactly.
 */
export async function downloadExternalFrame(
  sourceUrl: string,
  destPath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  const res = await fetch(sourceUrl, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // Re-encode strips EXIF (GPS/timestamps) — same privacy stance as the
  // training transform's _strip_exif on the classifier side.
  await sharp(buf).jpeg({ quality: 95 }).toFile(destPath);
}

/** Cached frame total: bytes on disk + file count under EXTERNAL_DIR. */
export interface ExternalCacheStats {
  bytes: number;
  fileCount: number;
}

/**
 * Recursively sum the size and count of cached frames under EXTERNAL_DIR.
 * Returns zeros when the directory is absent (nothing imported, or already
 * cleared) — the cache being empty is a normal state, not an error.
 */
export async function externalCacheStats(
  dir: string = EXTERNAL_DIR,
): Promise<ExternalCacheStats> {
  // Collect file paths first (readdir is cheap), then stat them with bounded
  // concurrency. On the droplet's overlay fs a sequential per-file stat over a
  // multi-GB cache (tens of thousands of frames) takes tens of seconds;
  // parallelising keeps it to a few. Symlinks are skipped (isFile/isDirectory
  // are false for them), so there is no cycle risk.
  const files: string[] = [];
  async function collect(d: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return; // dir absent → contributes nothing
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        await collect(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }
  await collect(dir);

  // Collect sizes into an array then sum — `bytes += await …` would capture the
  // accumulator before the await and lose updates across concurrent callbacks.
  const limit = pLimit(32);
  const sizes = await Promise.all(
    files.map((f) =>
      limit(async () => {
        try {
          return (await fs.stat(f)).size;
        } catch {
          return 0; // raced with a clear/import — count it as 0, don't fail
        }
      }),
    ),
  );
  const bytes = sizes.reduce((sum, n) => sum + n, 0);
  return { bytes, fileCount: files.length };
}

/**
 * Delete every cached frame under EXTERNAL_DIR, reclaiming the disk, and
 * recreate the (now empty) directory. The DB rows (images.path,
 * external_images.sourceUrl, detections, identifications) are untouched, so a
 * later export lazily re-downloads each frame from its sourceUrl. Idempotent:
 * clearing an already-empty or absent cache returns {0,0} rather than throwing.
 */
export async function clearExternalCache(
  dir: string = EXTERNAL_DIR,
): Promise<ExternalCacheStats> {
  const freed = await externalCacheStats(dir);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  return freed;
}
