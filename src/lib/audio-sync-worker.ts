import "server-only";

import { db } from "@/db";
import { deployments, type Deployment } from "@/db/schema";
import { and, eq, isNotNull } from "drizzle-orm";
import { AUDIO_DRIVE_LAST_SYNC_KEY } from "@/lib/app-state-keys";
import { JOB_TYPES } from "@/lib/job-types";
import {
  runDriveSyncWorkerGeneric,
  awaitJobTerminal,
} from "@/lib/drive-sync-worker-core";
import { scanDeploymentAudioInternal } from "@/lib/audio-sync-internals";

export { awaitJobTerminal };

/**
 * Run an audio Drive sync job. Delegates the job lifecycle, fan-out, and
 * cancellation handling to the generic core; this module supplies the
 * audio-specific deployment selector and per-deployment scan.
 *
 * Unlike camera-trap, audio sync has no discovery phase — audio deployments
 * are derived from existing rows in the `deployments` table (any row where
 * `upload_audio_folder_id` is set, surfaced by the upload-count refresh that
 * the camera-trap sync already runs). Audio sync only reconciles audio file
 * rows against Drive; it never creates deployments.
 */
export async function runAudioSyncWorker(jobId: number): Promise<void> {
  return runDriveSyncWorkerGeneric<Deployment>(jobId, {
    jobType: JOB_TYPES.AUDIO_SYNC,
    logTag: "audio-sync",
    revalidatePath: "/audio",
    lastSyncStateKey: AUDIO_DRIVE_LAST_SYNC_KEY,
    concurrencyEnvKey: "AUDIO_SYNC_CONCURRENCY",

    listDeployments: async (job) => {
      const baseFilter = and(
        isNotNull(deployments.uploadAudioFolderId),
        eq(deployments.excluded, false)
      );
      return job.cameraTrapProjectId
        ? await db
            .select()
            .from(deployments)
            .where(
              and(
                eq(deployments.cameraTrapProjectId, job.cameraTrapProjectId),
                baseFilter
              )
            )
        : await db.select().from(deployments).where(baseFilter);
    },

    scanOne: async (dep) => {
      if (!dep.uploadAudioFolderId) return;
      await scanDeploymentAudioInternal({
        id: dep.id,
        uploadAudioFolderId: dep.uploadAudioFolderId,
      });
    },
  });
}
