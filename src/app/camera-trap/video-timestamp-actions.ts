"use server";

/**
 * Video timestamp probe — tests metadata extraction strategies on one sample
 * video from a deployment so the user can see which approach will yield capture
 * timestamps before committing to a full processing run.
 */

import { db } from "@/db";
import { videos, deployments } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requirePermission } from "@/lib/auth";
import { getVideoMetadata } from "@/lib/frame-extractor";
import type { ActionResult } from "@/lib/types";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { log } from "@/lib/log";

export type VideoTimestampMethod = "metadata" | "filename_folder" | "none";

export interface VideoTimestampProbe {
  sampleFilename: string;
  /** ISO string from ffprobe container metadata (null if camera didn't write it) */
  creationTime: string | null;
  /** "HH:MM:SS" parsed from filename pattern like 124358_0797.mp4 */
  filenameTime: string | null;
  /** Parent folder name from Drive (e.g. "2026-02-25") */
  folderName: string | null;
  /** If folderName looks like a date, the parsed ISO date string */
  folderDate: string | null;
  /** Combined suggestion from filename + folder if both parseable */
  filenameTimestamp: string | null;
}

/** Regex for camera trap filenames where the first 6 digits encode HHMMSS */
const HHMMSS_REGEX = /^(\d{2})(\d{2})(\d{2})_/;

/** Regex for folder names that look like dates */
const DATE_FOLDER_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseFilenameTime(filename: string): string | null {
  const match = filename.match(HHMMSS_REGEX);
  if (!match) return null;
  const [, hh, mm, ss] = match;
  if (parseInt(hh) > 23 || parseInt(mm) > 59 || parseInt(ss) > 59) return null;
  return `${hh}:${mm}:${ss}`;
}

function parseFolderDate(name: string): string | null {
  const match = name.match(DATE_FOLDER_REGEX);
  if (!match) return null;
  const [, yyyy, mm, dd] = match;
  const d = new Date(`${yyyy}-${mm}-${dd}T00:00:00`);
  if (isNaN(d.getTime())) return null;
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Probe one video from a deployment to test which timestamp extraction methods
 * produce usable results. Downloads the video temporarily if not cached locally.
 */
export async function probeVideoTimestamp(
  deploymentId: number,
): Promise<ActionResult<VideoTimestampProbe>> {
  await requirePermission("camera-trap", "editor");

  // 1. Pick a sample video (prefer one already on disk)
  const vids = await db
    .select()
    .from(videos)
    .where(eq(videos.deploymentId, deploymentId))
    .limit(10);

  if (vids.length === 0) {
    return { success: false, error: "No hay videos en esta instalación" };
  }

  const sample = vids.find((v) => v.path) ?? vids[0];

  // 2. Ensure we have a local file to probe
  let probePath = sample.path;
  let tempFile: string | null = null;

  if (!probePath) {
    if (!sample.driveFileId) {
      return { success: false, error: "Video sin fuente disponible" };
    }

    // Download to temp directory
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ct-probe-"));
    tempFile = path.join(tmpDir, sample.filename);
    try {
      const { downloadFile } = await import("@/lib/drive-client");
      await downloadFile(sample.driveFileId, tempFile);
      probePath = tempFile;
    } catch (err) {
      log.error({ err, videoId: sample.id }, "[probeVideoTimestamp] Download failed");
      // Clean up temp dir
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      return { success: false, error: "No se pudo descargar el video de prueba" };
    }
  }

  // 3. Probe with ffprobe
  let creationTime: string | null = null;
  try {
    const metadata = await getVideoMetadata(probePath);
    if (metadata?.creationTime) {
      creationTime = metadata.creationTime.toISOString();
    }
  } catch (err) {
    log.warn({ err, videoId: sample.id }, "[probeVideoTimestamp] ffprobe failed");
  }

  // 4. Parse filename for HHMMSS
  const filenameTime = parseFilenameTime(sample.filename);

  // 5. Get Drive parent folder name
  let folderName: string | null = null;
  let folderDate: string | null = null;
  if (sample.driveFileId) {
    try {
      const { getDriveFileParentName } = await import("@/lib/drive-client");
      folderName = await getDriveFileParentName(sample.driveFileId);
      if (folderName) {
        folderDate = parseFolderDate(folderName);
      }
    } catch (err) {
      log.warn({ err }, "[probeVideoTimestamp] Could not get parent folder name");
    }
  }

  // 6. Combine filename time + folder date into a full timestamp
  let filenameTimestamp: string | null = null;
  if (filenameTime && folderDate) {
    filenameTimestamp = `${folderDate}T${filenameTime}`;
  }

  // Clean up temp file
  if (tempFile) {
    const tmpDir = path.dirname(tempFile);
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  return {
    success: true,
    data: {
      sampleFilename: sample.filename,
      creationTime,
      filenameTime,
      folderName,
      folderDate,
      filenameTimestamp,
    },
  };
}
