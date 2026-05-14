"use server";

/**
 * Lightweight preview actions for audio compression / revert confirmation
 * dialogs.
 *
 * Split out from `compression-actions.ts` so that calling them does not
 * pull in the audio-compression-core module — which transitively imports
 * `drive-client` (googleapis ≈ 10 MB), `flac-runner` (spawns Python), and
 * `audio-cache`. Those are unnecessary for showing "X archivos, Y MB" and
 * make the dialog feel sluggish in dev / cold starts.
 *
 * Only depends on the local DB + drizzle helpers. Mirrors the
 * `src/app/camera-trap/preview-actions.ts` pattern.
 */

import { db } from "@/db";
import { audioFiles } from "@/db/schema";
import { and, eq, inArray, sql, count, sum } from "drizzle-orm";
import { requirePermission } from "@/lib/auth";
import type { ActionResult } from "@/lib/types";

// Empirically observed PAM mean ratio (RWS Collaborative + WildLabs + Arbimon).
const ESTIMATED_RATIO = 0.55;

export async function getAudioCompressionPreviewAction(
  deploymentIds: number[],
): Promise<
  ActionResult<{
    count: number;
    totalSizeMB: number;
    estimatedSavedMB: number;
  }>
> {
  await requirePermission("grabaciones", "editor");

  if (deploymentIds.length === 0) {
    return {
      success: true,
      data: { count: 0, totalSizeMB: 0, estimatedSavedMB: 0 },
    };
  }

  const result = await db
    .select({ cnt: count(), totalSize: sum(audioFiles.fileSize) })
    .from(audioFiles)
    .where(
      and(
        inArray(audioFiles.deploymentId, deploymentIds),
        eq(audioFiles.compressed, false),
        sql`${audioFiles.driveFileId} IS NOT NULL`,
        sql`lower(${audioFiles.filename}) LIKE '%.wav'`,
      ),
    );

  const row = result[0];
  const totalBytes = (row?.totalSize as number | null) ?? 0;
  return {
    success: true,
    data: {
      count: row?.cnt ?? 0,
      totalSizeMB: Math.round((totalBytes / (1024 * 1024)) * 10) / 10,
      estimatedSavedMB:
        Math.round(((totalBytes * (1 - ESTIMATED_RATIO)) / (1024 * 1024)) * 10) /
        10,
    },
  };
}

export async function getAudioRevertPreviewAction(
  deploymentId: number,
): Promise<ActionResult<{ count: number; reclaimableMB: number }>> {
  await requirePermission("grabaciones", "editor");

  const result = await db
    .select({
      cnt: count(),
      origTotal: sum(audioFiles.originalFileSize),
      curTotal: sum(audioFiles.fileSize),
    })
    .from(audioFiles)
    .where(
      and(
        eq(audioFiles.deploymentId, deploymentId),
        eq(audioFiles.compressed, true),
        sql`${audioFiles.originalDriveRevisionId} IS NOT NULL`,
        sql`${audioFiles.driveFileId} IS NOT NULL`,
      ),
    );

  const row = result[0];
  const orig = (row?.origTotal as number | null) ?? 0;
  const cur = (row?.curTotal as number | null) ?? 0;
  return {
    success: true,
    data: {
      count: row?.cnt ?? 0,
      reclaimableMB: Math.round(((orig - cur) / (1024 * 1024)) * 10) / 10,
    },
  };
}
