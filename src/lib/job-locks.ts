/**
 * Active-job mutex helpers — single source of truth for "is this deployment
 * busy?" checks across audio jobs.
 *
 * Bidirectional: an in-flight audio_compression job blocks BirdNET / indices /
 * unified analysis / audio sync, and vice versa. The reconciliation pre-check
 * inside the compression processor is the safety net for the (very narrow)
 * window between this query and the actual write.
 */

import "server-only";

import { db } from "@/db";
import { processingJobs } from "@/db/schema";
import { and, eq, inArray, or } from "drizzle-orm";
import { JOB_TYPES, type JobType } from "@/lib/job-types";

/**
 * The set of job types that operate on a deployment's audio files. A deployment
 * may have at most one of these in `pending` or `processing` at a time.
 */
export const AUDIO_JOB_TYPES = [
  JOB_TYPES.BIRDNET,
  JOB_TYPES.ACOUSTIC_INDICES,
  JOB_TYPES.AUDIO_ANALYSIS,
  JOB_TYPES.AUDIO_SYNC,
  JOB_TYPES.AUDIO_COMPRESSION,
  JOB_TYPES.REVERT_AUDIO_COMPRESSION,
] as const satisfies readonly JobType[];

export async function findActiveAudioJob(
  deploymentId: number,
): Promise<{ id: number; jobType: string } | null> {
  const [active] = await db
    .select({ id: processingJobs.id, jobType: processingJobs.jobType })
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.deploymentId, deploymentId),
        inArray(processingJobs.jobType, [...AUDIO_JOB_TYPES]),
        inArray(processingJobs.status, ["pending", "processing"]),
      ),
    )
    .limit(1);
  return active ?? null;
}

/**
 * The set of job types that operate on a deployment's camera-trap images.
 * A deployment may have at most one of these `pending`/`processing` at a time.
 *
 * This is the single source of truth for "is this deployment currently being
 * processed?" — the UI and guards derive processing state from a live query of
 * these jobs rather than from a denormalized `deployments.status = "processing"`
 * column (which could drift out of sync when a job was killed or cancelled).
 */
export const CAMERA_TRAP_ACTIVE_JOB_TYPES = [
  JOB_TYPES.ML,
  JOB_TYPES.ML_INCREMENTAL,
  JOB_TYPES.COMPRESSION,
  JOB_TYPES.REVERT_COMPRESSION,
] as const satisfies readonly JobType[];

export async function findActiveCameraTrapJob(
  deploymentId: number,
): Promise<{ id: number; jobType: string } | null> {
  const [active] = await db
    .select({ id: processingJobs.id, jobType: processingJobs.jobType })
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.deploymentId, deploymentId),
        inArray(processingJobs.jobType, [...CAMERA_TRAP_ACTIVE_JOB_TYPES]),
        inArray(processingJobs.status, ["pending", "processing"]),
      ),
    )
    .limit(1);
  return active ?? null;
}

/**
 * Batch variant for list views: returns the set of deployment IDs that have an
 * active camera-trap job. One indexed query instead of N per-row lookups.
 */
export async function findActiveCameraTrapJobIds(
  deploymentIds: number[],
): Promise<Set<number>> {
  if (deploymentIds.length === 0) return new Set();
  const rows = await db
    .select({ deploymentId: processingJobs.deploymentId })
    .from(processingJobs)
    .where(
      and(
        inArray(processingJobs.deploymentId, deploymentIds),
        inArray(processingJobs.jobType, [...CAMERA_TRAP_ACTIVE_JOB_TYPES]),
        inArray(processingJobs.status, ["pending", "processing"]),
      ),
    );
  const ids = new Set<number>();
  for (const r of rows) {
    if (r.deploymentId != null) ids.add(r.deploymentId);
  }
  return ids;
}

/**
 * Count concurrent AUDIO_COMPRESSION jobs across all deployments. Used to
 * enforce a global "only one at a time" cap so the admin can't accidentally
 * saturate the droplet by queuing every deployment.
 */
export async function countActiveAudioCompressionJobs(): Promise<number> {
  const rows = await db
    .select({ id: processingJobs.id })
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.jobType, JOB_TYPES.AUDIO_COMPRESSION),
        inArray(processingJobs.status, ["pending", "processing"]),
      ),
    );
  return rows.length;
}

/**
 * Like `countActiveAudioCompressionJobs` but also counts audio_analysis jobs
 * that include an embedded compression phase (`compress_first = true`). Both
 * shapes consume the same CPU-bound FLAC encoder, so the global "one
 * compression at a time" cap must cover both.
 */
/**
 * Single-flight for the shared-drive reconciliation job. Returns the active
 * job (pending or processing) if one exists, else null. Checked in both the
 * cron endpoint and the admin "Reconcile now" action so we never enqueue a
 * duplicate reconcile.
 */
export async function findActiveSharedDriveReconcileJob(): Promise<
  { id: number; status: string } | null
> {
  const [active] = await db
    .select({ id: processingJobs.id, status: processingJobs.status })
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.jobType, JOB_TYPES.SHARED_DRIVES_RECONCILE),
        inArray(processingJobs.status, ["pending", "processing"]),
      ),
    )
    .limit(1);
  return active ?? null;
}

export async function countActiveAudioWorkWithCompression(): Promise<number> {
  const rows = await db
    .select({ id: processingJobs.id })
    .from(processingJobs)
    .where(
      and(
        inArray(processingJobs.status, ["pending", "processing"]),
        or(
          eq(processingJobs.jobType, JOB_TYPES.AUDIO_COMPRESSION),
          and(
            eq(processingJobs.jobType, JOB_TYPES.AUDIO_ANALYSIS),
            eq(processingJobs.compressFirst, true),
          ),
        ),
      ),
    );
  return rows.length;
}
