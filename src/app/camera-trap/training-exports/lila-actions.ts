"use server";

/**
 * Admin server actions for LILA external-image management, co-located with the
 * training-export UI that consumes the data.
 *
 * - `enqueueExternalImport` claims a single-flight job and fires the background
 *   import (download precomputed-box frames → verified train-only rows). Kept in
 *   the shared model-server single-flight group so two heavy jobs don't strain
 *   the droplet at once.
 * - `clearLilaImages` reclaims the on-disk frame cache (data/external) without
 *   touching DB rows — a later export lazily re-downloads each frame from its
 *   retained sourceUrl (see lib/external/image-bytes.ts). Guarded against running
 *   while an export or import is in flight, since deleting frames mid-export
 *   would break in-progress crops.
 */

import { and, inArray } from "drizzle-orm";

import { db } from "@/db";
import { processingJobs, type ProcessingJob } from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { JOB_TYPES } from "@/lib/job-types";
import { processExternalImportJob } from "@/lib/external/import-job";
import { LILA_DATASETS, DEFAULT_REQUESTED_CLASSES } from "@/lib/external/datasets";
import {
  clearExternalCache,
  externalCacheStats,
  type ExternalCacheStats,
} from "@/lib/external/frame-cache";
import { log } from "@/lib/log";

/** Job types that share the singleton model server and must not run concurrently. */
const SERVER_JOB_TYPES = [
  JOB_TYPES.EXTERNAL_IMPORT,
  JOB_TYPES.ML,
  JOB_TYPES.ML_INCREMENTAL,
];

/** Jobs that read or write data/external — clearing while these run is unsafe. */
const FRAME_USING_JOB_TYPES = [
  JOB_TYPES.TRAINING_EXPORT,
  JOB_TYPES.EXTERNAL_IMPORT,
];

export type ImportDispatchResult =
  | { success: true; jobId: number }
  | { success: false; error: string };

export async function enqueueExternalImport(
  formData: FormData,
): Promise<ImportDispatchResult> {
  const user = await requireAdmin();

  const datasetSlugs = (formData.getAll("dataset") as string[]).filter(
    (s) => s in LILA_DATASETS,
  );
  if (datasetSlugs.length === 0) {
    return { success: false, error: "Selecciona al menos un conjunto de datos." };
  }
  const requested = (formData.getAll("class") as string[]).filter(Boolean);
  const requestedClasses =
    requested.length > 0 ? requested : DEFAULT_REQUESTED_CLASSES;
  const datasets = datasetSlugs.map((s) => LILA_DATASETS[s]);

  // Single-flight: no concurrent jobs that use the shared model server.
  const jobRow = db.transaction((tx) => {
    const active = tx
      .select({ id: processingJobs.id })
      .from(processingJobs)
      .where(
        and(
          inArray(processingJobs.jobType, SERVER_JOB_TYPES),
          inArray(processingJobs.status, ["pending", "processing"]),
        ),
      )
      .limit(1)
      .all();
    if (active.length > 0) return null;
    return tx
      .insert(processingJobs)
      .values({
        jobType: JOB_TYPES.EXTERNAL_IMPORT,
        status: "processing",
        totalImages: 0,
        processedImages: 0,
        createdBy: user.email,
        startedAt: new Date(),
        statusMessage: "Iniciando importación externa…",
      })
      .returning()
      .get() as ProcessingJob;
  });

  if (!jobRow) {
    return {
      success: false,
      error:
        "Hay otro trabajo de detección o importación en curso. Espera a que termine.",
    };
  }

  void processExternalImportJob(jobRow.id, {
    datasets,
    requestedClasses,
    createdBy: user.email,
  });

  return { success: true, jobId: jobRow.id };
}

/**
 * On-disk frame-cache size. Loaded lazily from the client (not during page
 * render) because walking a multi-GB cache on the droplet can take seconds —
 * blocking render on it makes the page appear to hang.
 */
export async function getLilaCacheStats(): Promise<ExternalCacheStats> {
  await requireAdmin();
  return externalCacheStats();
}

export type ClearLilaResult =
  | { success: true; freedBytes: number; fileCount: number }
  | { success: false; error: string };

export async function clearLilaImages(): Promise<ClearLilaResult> {
  const user = await requireAdmin();

  const active = db
    .select({ id: processingJobs.id })
    .from(processingJobs)
    .where(
      and(
        inArray(processingJobs.jobType, FRAME_USING_JOB_TYPES),
        inArray(processingJobs.status, ["pending", "processing"]),
      ),
    )
    .limit(1)
    .all();
  if (active.length > 0) {
    return {
      success: false,
      error:
        "Hay un exporte o importación en curso. Espera a que termine antes de borrar las imágenes.",
    };
  }

  const freed = await clearExternalCache();
  log.info(
    { user: user.email, freedBytes: freed.bytes, fileCount: freed.fileCount },
    "[lila] cleared external frame cache",
  );
  return { success: true, freedBytes: freed.bytes, fileCount: freed.fileCount };
}
