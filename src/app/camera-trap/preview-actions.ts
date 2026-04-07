"use server";

/**
 * Lightweight preview actions for confirmation dialogs.
 *
 * These are split out from `drive-actions.ts` so that calling them does not
 * pull in the `googleapis` dependency tree (which is ~10MB and slow to load
 * in dev mode). They only run small SQL aggregates against the local DB.
 */

import { db } from "@/db";
import { images } from "@/db/schema";
import { and, eq, inArray, or, sql, count, sum } from "drizzle-orm";
import { requirePermission } from "@/lib/auth";
import type { ActionResult } from "@/lib/types";

export async function getCompressionPreview(
  deploymentId: number,
): Promise<ActionResult<{ count: number; totalSizeMB: number }>> {
  await requirePermission("camera-trap", "admin");

  const result = await db
    .select({
      cnt: count(),
      totalSize: sum(images.fileSize),
    })
    .from(images)
    .where(
      and(
        eq(images.deploymentId, deploymentId),
        eq(images.compressed, false),
        sql`${images.driveFileId} IS NOT NULL`,
        or(
          sql`lower(${images.filename}) LIKE '%.jpg'`,
          sql`lower(${images.filename}) LIKE '%.jpeg'`,
        ),
      ),
    );

  const row = result[0];
  return {
    success: true,
    data: {
      count: row?.cnt ?? 0,
      totalSizeMB: Math.round(((row?.totalSize as number | null) ?? 0) / (1024 * 1024) * 10) / 10,
    },
  };
}

export async function getCompressionPreviewBatch(
  deploymentIds: number[],
): Promise<ActionResult<{ count: number; totalSizeMB: number }>> {
  await requirePermission("camera-trap", "admin");

  if (deploymentIds.length === 0) {
    return { success: true, data: { count: 0, totalSizeMB: 0 } };
  }

  const result = await db
    .select({
      cnt: count(),
      totalSize: sum(images.fileSize),
    })
    .from(images)
    .where(
      and(
        inArray(images.deploymentId, deploymentIds),
        eq(images.compressed, false),
        sql`${images.driveFileId} IS NOT NULL`,
        or(
          sql`lower(${images.filename}) LIKE '%.jpg'`,
          sql`lower(${images.filename}) LIKE '%.jpeg'`,
        ),
      ),
    );

  const row = result[0];
  return {
    success: true,
    data: {
      count: row?.cnt ?? 0,
      totalSizeMB: Math.round(((row?.totalSize as number | null) ?? 0) / (1024 * 1024) * 10) / 10,
    },
  };
}

export async function getRevertPreview(
  deploymentId: number,
): Promise<ActionResult<{ count: number; savedMB: number }>> {
  await requirePermission("camera-trap", "admin");

  const result = await db
    .select({
      cnt: count(),
      totalOriginal: sum(images.originalFileSize),
      totalCurrent: sum(images.fileSize),
    })
    .from(images)
    .where(
      and(
        eq(images.deploymentId, deploymentId),
        eq(images.compressed, true),
        sql`${images.originalFileSize} IS NOT NULL`,
        sql`${images.driveFileId} IS NOT NULL`,
      ),
    );

  const row = result[0];
  const origTotal = (row?.totalOriginal as number | null) ?? 0;
  const curTotal = (row?.totalCurrent as number | null) ?? 0;
  return {
    success: true,
    data: {
      count: row?.cnt ?? 0,
      savedMB: Math.round((origTotal - curTotal) / (1024 * 1024) * 10) / 10,
    },
  };
}
