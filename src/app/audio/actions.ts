"use server";

import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import {
  deployments,
  audioFiles,
  cameraTrapProjects,
} from "@/db/schema";
import { eq, sql, and, isNotNull, count as drizzleCount } from "drizzle-orm";
import {
  listFolderFiles,
  AUDIO_EXTENSIONS,
} from "@/lib/drive-client";
import {
  getUserCameraTrapProjects,
  ctProjectFilter,
  requireDeploymentAccess,
} from "@/lib/camera-trap-auth";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/types";
import path from "path";

// Browser-native audio formats
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AudioDeploymentRow {
  id: number;
  name: string;
  siteName: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  ctProjectName: string | null;
  uploadAudioCount: number | null;
  uploadAudioFolderId: string | null;
  audioFileCount: number;
  lastScanned: Date | null;
}

export interface AudioFileRow {
  id: number;
  filename: string;
  driveFileId: string | null;
  fileSize: number | null;
  mimeType: string | null;
  modifiedAt: Date | null;
  format: string | null;
  playable: boolean;
}

export interface AudioStats {
  totalDeployments: number;
  totalFiles: number;
  totalSizeBytes: number;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function fetchAudioDeployments(): Promise<
  ActionResult<AudioDeploymentRow[]>
> {
  const user = await requirePermission("camera-trap", "viewer");
  const projects = await getUserCameraTrapProjects(user);
  const filter = ctProjectFilter(projects);

  const rows = await db
    .select({
      id: deployments.id,
      name: deployments.name,
      siteName: deployments.siteName,
      dateStart: deployments.dateStart,
      dateEnd: deployments.dateEnd,
      ctProjectName: cameraTrapProjects.name,
      uploadAudioCount: deployments.uploadAudioCount,
      uploadAudioFolderId: deployments.uploadAudioFolderId,
      audioFileCount: sql<number>`(
        SELECT COUNT(*) FROM audio_files
        WHERE audio_files.deployment_id = ${deployments.id}
      )`,
      lastScanned: sql<Date | null>`(
        SELECT MAX(created_at) FROM audio_files
        WHERE audio_files.deployment_id = ${deployments.id}
      )`,
    })
    .from(deployments)
    .leftJoin(
      cameraTrapProjects,
      eq(deployments.cameraTrapProjectId, cameraTrapProjects.id)
    )
    .where(
      and(
        filter,
        isNotNull(deployments.uploadAudioFolderId)
      )
    )
    .orderBy(deployments.name);

  return { success: true, data: rows };
}

export async function fetchAudioFiles(
  deploymentId: number
): Promise<ActionResult<AudioFileRow[]>> {
  const user = await requirePermission("camera-trap", "viewer");
  await requireDeploymentAccess(user, deploymentId);

  const rows = await db
    .select({
      id: audioFiles.id,
      filename: audioFiles.filename,
      driveFileId: audioFiles.driveFileId,
      fileSize: audioFiles.fileSize,
      mimeType: audioFiles.mimeType,
      modifiedAt: audioFiles.modifiedAt,
      format: audioFiles.format,
      playable: audioFiles.playable,
    })
    .from(audioFiles)
    .where(eq(audioFiles.deploymentId, deploymentId))
    .orderBy(audioFiles.filename);

  return { success: true, data: rows };
}

export async function getAudioStats(): Promise<ActionResult<AudioStats>> {
  await requirePermission("camera-trap", "viewer");

  const [stats] = await db
    .select({
      totalFiles: drizzleCount(),
      totalSizeBytes: sql<number>`COALESCE(SUM(${audioFiles.fileSize}), 0)`,
    })
    .from(audioFiles);

  const [depCount] = await db
    .select({
      totalDeployments: sql<number>`COUNT(DISTINCT ${audioFiles.deploymentId})`,
    })
    .from(audioFiles);

  return {
    success: true,
    data: {
      totalDeployments: depCount?.totalDeployments ?? 0,
      totalFiles: stats?.totalFiles ?? 0,
      totalSizeBytes: stats?.totalSizeBytes ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Scan actions
// ---------------------------------------------------------------------------

export async function scanDeploymentAudio(
  deploymentId: number
): Promise<ActionResult<{ added: number; updated: number; total: number }>> {
  const user = await requirePermission("camera-trap", "editor");
  await requireDeploymentAccess(user, deploymentId);

  // Get the deployment's audio folder ID
  const [dep] = await db
    .select({
      uploadAudioFolderId: deployments.uploadAudioFolderId,
    })
    .from(deployments)
    .where(eq(deployments.id, deploymentId));

  if (!dep?.uploadAudioFolderId) {
    return {
      success: false,
      error: "Esta instalación no tiene carpeta de audio en Drive",
    };
  }

  // List files from Drive
  const driveFiles = await listFolderFiles(
    dep.uploadAudioFolderId,
    AUDIO_EXTENSIONS
  );

  let added = 0;
  let updated = 0;

  for (const file of driveFiles) {
    const ext = path.extname(file.name).toLowerCase().replace(".", "");
    const playable = PLAYABLE_FORMATS.has(ext);
    const mimeType = AUDIO_MIME_TYPES[ext] ?? "application/octet-stream";
    const modifiedAt = file.modifiedTime
      ? new Date(file.modifiedTime)
      : null;

    // Upsert: try insert, on conflict update
    const existing = await db
      .select({ id: audioFiles.id })
      .from(audioFiles)
      .where(
        and(
          eq(audioFiles.deploymentId, deploymentId),
          eq(audioFiles.driveFileId, file.id)
        )
      );

    if (existing.length > 0) {
      await db
        .update(audioFiles)
        .set({
          filename: file.name,
          fileSize: file.size ?? null,
          mimeType,
          modifiedAt: modifiedAt ?? null,
          format: ext,
          playable,
        })
        .where(eq(audioFiles.id, existing[0].id));
      updated++;
    } else {
      await db.insert(audioFiles).values({
        deploymentId,
        filename: file.name,
        driveFileId: file.id,
        fileSize: file.size ?? null,
        mimeType,
        modifiedAt: modifiedAt ?? null,
        format: ext,
        playable,
      });
      added++;
    }
  }

  // Remove files that no longer exist on Drive
  const driveFileIds = new Set(driveFiles.map((f) => f.id));
  const dbFiles = await db
    .select({ id: audioFiles.id, driveFileId: audioFiles.driveFileId })
    .from(audioFiles)
    .where(eq(audioFiles.deploymentId, deploymentId));

  for (const dbFile of dbFiles) {
    if (dbFile.driveFileId && !driveFileIds.has(dbFile.driveFileId)) {
      await db.delete(audioFiles).where(eq(audioFiles.id, dbFile.id));
    }
  }

  revalidatePath("/audio");
  revalidatePath(`/audio/${deploymentId}`);

  return {
    success: true,
    data: {
      added,
      updated,
      total: driveFiles.length,
    },
  };
}

export async function scanAllAudio(): Promise<
  ActionResult<{ scanned: number; errors: number }>
> {
  await requirePermission("camera-trap", "editor");

  // Get all deployments with audio folders
  const deps = await db
    .select({
      id: deployments.id,
      uploadAudioFolderId: deployments.uploadAudioFolderId,
    })
    .from(deployments)
    .where(isNotNull(deployments.uploadAudioFolderId));

  let scanned = 0;
  let errors = 0;

  for (const dep of deps) {
    try {
      await scanDeploymentAudio(dep.id);
      scanned++;
    } catch (err) {
      console.error(
        `[audio] Failed to scan deployment ${dep.id}:`,
        err instanceof Error ? err.message : err
      );
      errors++;
    }
  }

  revalidatePath("/audio");
  return { success: true, data: { scanned, errors } };
}
