import "server-only";

import path from "path";
import { db } from "@/db";
import { audioFiles, audioDetections } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { listFolderFiles, AUDIO_EXTENSIONS } from "@/lib/drive-client";

// Browser-native audio formats — used to set the `playable` flag so the UI
// can decide whether to show inline playback or a download-only affordance.
const PLAYABLE_FORMATS = new Set(["wav", "mp3", "flac", "ogg", "aac", "m4a"]);

const AUDIO_MIME_TYPES: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  flac: "audio/flac",
  ogg: "audio/ogg",
  aac: "audio/aac",
  m4a: "audio/mp4",
  wac: "application/octet-stream",
  w4v: "application/octet-stream",
};

export interface AudioScanResult {
  added: number;
  updated: number;
  total: number;
}

/**
 * Scan a single deployment's audio folder on Drive and reconcile the
 * `audio_files` table:
 *   - upsert rows for every file currently on Drive
 *   - soft-delete files that disappeared from Drive but have annotations
 *     (null the driveFileId; preserve detection rows)
 *   - hard-delete files that disappeared and have no annotations
 *
 * Returns the counts for the caller to summarise. Caller is responsible
 * for auth and (if running standalone) for revalidating affected paths.
 */
export async function scanDeploymentAudioInternal(deployment: {
  id: number;
  uploadAudioFolderId: string;
}): Promise<AudioScanResult> {
  const driveFiles = await listFolderFiles(
    deployment.uploadAudioFolderId,
    AUDIO_EXTENSIONS
  );

  const driveFileIds = new Set(driveFiles.map((f) => f.id));

  // better-sqlite3 transactions are synchronous — callback must be a plain
  // function (never async) or it throws at runtime.
  const result = db.transaction((tx) => {
    let added = 0;
    let updated = 0;

    for (const file of driveFiles) {
      const ext = path.extname(file.name).toLowerCase().replace(".", "");
      const playable = PLAYABLE_FORMATS.has(ext);
      const mimeType = AUDIO_MIME_TYPES[ext] ?? "application/octet-stream";
      const modifiedAt = file.modifiedTime ? new Date(file.modifiedTime) : null;

      const [existing] = tx
        .select({ id: audioFiles.id })
        .from(audioFiles)
        .where(
          and(
            eq(audioFiles.deploymentId, deployment.id),
            eq(audioFiles.driveFileId, file.id)
          )
        )
        .all();

      if (existing) {
        tx.update(audioFiles)
          .set({
            filename: file.name,
            fileSize: file.size ?? null,
            mimeType,
            modifiedAt: modifiedAt ?? null,
            format: ext,
            playable,
          })
          .where(eq(audioFiles.id, existing.id))
          .run();
        updated++;
      } else {
        tx.insert(audioFiles)
          .values({
            deploymentId: deployment.id,
            filename: file.name,
            driveFileId: file.id,
            fileSize: file.size ?? null,
            mimeType,
            modifiedAt: modifiedAt ?? null,
            format: ext,
            playable,
          })
          .run();
        added++;
      }
    }

    const dbFiles = tx
      .select({ id: audioFiles.id, driveFileId: audioFiles.driveFileId })
      .from(audioFiles)
      .where(eq(audioFiles.deploymentId, deployment.id))
      .all();

    for (const dbFile of dbFiles) {
      if (dbFile.driveFileId && !driveFileIds.has(dbFile.driveFileId)) {
        const [det] = tx
          .select({ id: audioDetections.id })
          .from(audioDetections)
          .where(eq(audioDetections.audioFileId, dbFile.id))
          .limit(1)
          .all();

        if (det) {
          // Soft-delete: preserve the row (annotations reference it) but
          // clear the Drive reference so the UI marks it unavailable.
          tx.update(audioFiles)
            .set({ driveFileId: null })
            .where(eq(audioFiles.id, dbFile.id))
            .run();
        } else {
          tx.delete(audioFiles).where(eq(audioFiles.id, dbFile.id)).run();
        }
      }
    }

    return { added, updated, total: driveFiles.length };
  });

  return result;
}
