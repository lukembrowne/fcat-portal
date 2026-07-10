/**
 * Resolve the source bytes for one export candidate, regardless of where the
 * frame lives. Kept out of the "use server" actions module so it can be
 * unit-tested without the all-exports-must-be-async constraint.
 *
 * Resolution order:
 *   1. Local cache file at `imagePath` (FCAT chunked-ML cache or external cache).
 *   2. External cache MISS → re-download from the retained LILA `sourceUrl`
 *      (external frames are a regenerable cache; the file may have been cleared
 *      to reclaim disk). The re-download uses the same scrub+encode as import,
 *      so the resulting crop is byte-identical.
 *   3. Drive fallback via `driveFileId` (FCAT images whose cache was evicted).
 *
 * A row with neither a fetchable local path nor a driveFileId throws — the
 * export crop loop catches this per-image and records a skip-with-warning.
 */

import { promises as fs } from "node:fs";

import { downloadFileToBuffer } from "@/lib/drive-client";
import { downloadExternalFrame } from "@/lib/external/frame-cache";

/** The subset of an export candidate that `loadImageBytes` needs. */
export interface LoadableImage {
  imageId: number;
  filename: string;
  imagePath: string | null;
  driveFileId: string | null;
  isExternal: boolean;
  sourceUrl: string | null;
}

export async function loadImageBytes(row: LoadableImage): Promise<Buffer> {
  if (row.imagePath) {
    try {
      return await fs.readFile(row.imagePath);
    } catch {
      // Cache miss. External (LILA) frames are a regenerable cache: if the file
      // was cleared to reclaim disk, re-download it from its retained sourceUrl
      // (same EXIF scrub + jpeg encode as import → byte-identical crop), cache
      // it back to imagePath, and return. A null sourceUrl (pre-provenance row)
      // falls through to the driveFileId path below, which throws for external
      // rows — preserving the existing skip-with-warning behaviour.
      if (row.isExternal && row.sourceUrl) {
        await downloadExternalFrame(row.sourceUrl, row.imagePath);
        return await fs.readFile(row.imagePath);
      }
      // Otherwise fall through to Drive.
    }
  }
  if (!row.driveFileId) {
    throw new Error(
      `image ${row.imageId} (${row.filename}) has no local path and no driveFileId`,
    );
  }
  return await downloadFileToBuffer(row.driveFileId);
}
