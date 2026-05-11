"use server";

import { db } from "@/db";
import { processingJobs, cameraTrapProjects, deployments } from "@/db/schema";
import { eq, and, inArray, isNotNull, count } from "drizzle-orm";
import { after } from "next/server";
import { requirePermission } from "@/lib/auth";
import { getUserCameraTrapProjects } from "@/lib/camera-trap-auth";
import { runAudioSyncWorker } from "@/lib/audio-sync-worker";
import { JOB_TYPES } from "@/lib/job-types";
import { log } from "@/lib/log";
import type { ActionResult } from "@/lib/types";

/**
 * Enqueue an `audio_sync` background job. Runs the audio scan workflow
 * (Drive listing + audio_files reconciliation) in a worker process via
 * `after()`. Single-flight: at most one audio_sync job pending or
 * processing at a time, regardless of scope. Mirrors the camera-trap
 * `enqueueDriveSyncJob` pattern.
 */
export async function enqueueAudioSyncJob(
  cameraTrapProjectId?: number
): Promise<ActionResult<{ jobId: number }>> {
  const user = await requirePermission("grabaciones", "editor");
  const ctProjects = await getUserCameraTrapProjects(user);

  if (cameraTrapProjectId != null) {
    if (ctProjects !== "all" && !ctProjects.includes(cameraTrapProjectId)) {
      return { success: false, error: "No tienes acceso a este proyecto" };
    }
    const [proj] = await db
      .select({ id: cameraTrapProjects.id })
      .from(cameraTrapProjects)
      .where(eq(cameraTrapProjects.id, cameraTrapProjectId));
    if (!proj) {
      return { success: false, error: "Proyecto no encontrado" };
    }
    const [hasAudio] = await db
      .select({ n: count() })
      .from(deployments)
      .where(
        and(
          eq(deployments.cameraTrapProjectId, cameraTrapProjectId),
          isNotNull(deployments.uploadAudioFolderId)
        )
      );
    if ((hasAudio?.n ?? 0) === 0) {
      return {
        success: false,
        error: "Este proyecto no tiene instalaciones con carpeta de audio",
      };
    }
  }

  const [inflight] = await db
    .select({ id: processingJobs.id })
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.jobType, JOB_TYPES.AUDIO_SYNC),
        inArray(processingJobs.status, ["pending", "processing"])
      )
    );

  if (inflight) {
    return {
      success: false,
      error: "Ya hay una sincronización de audio en curso",
    };
  }

  const [job] = await db
    .insert(processingJobs)
    .values({
      jobType: JOB_TYPES.AUDIO_SYNC,
      deploymentId: null,
      cameraTrapProjectId: cameraTrapProjectId ?? null,
      status: "pending",
      totalImages: 0,
      processedImages: 0,
      failedImages: 0,
      statusMessage: "En cola...",
      createdBy: user.email,
    })
    .returning();

  after(() =>
    runAudioSyncWorker(job.id).catch((err) =>
      log.error({ err, jobId: job.id }, "[audio-sync] worker rejected")
    )
  );

  return { success: true, data: { jobId: job.id } };
}
