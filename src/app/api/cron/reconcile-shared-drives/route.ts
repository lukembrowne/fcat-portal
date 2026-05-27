/**
 * Cron endpoint: reconcile all registered Shared Drives.
 *
 * Trues up each drive's item count against Drive API ground truth, health-checks
 * SA access, and emits capacity / threshold events. Invoked nightly via curl
 * from inside the container (localhost only).
 *
 * Auth: Bearer CRON_SECRET (timing-safe). Localhost-only: rejects any request
 * carrying X-Forwarded-For (those came through the public oauth2-proxy path).
 * Single-flight: never enqueues a second reconcile while one is in flight.
 */

import { db } from "@/db";
import { processingJobs } from "@/db/schema";
import { verifyCronSecret } from "@/lib/cron-auth";
import { findActiveSharedDriveReconcileJob } from "@/lib/job-locks";
import { runReconciliationJob } from "@/lib/shared-drive-reconciliation-worker";
import { JOB_TYPES } from "@/lib/job-types";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!verifyCronSecret(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Cron runs in-container against localhost; the public path would set XFF.
  if (request.headers.get("x-forwarded-for")) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    // Single-flight: reuse / refuse an in-flight reconcile.
    const active = await findActiveSharedDriveReconcileJob();
    if (active && active.status === "processing") {
      return Response.json({ already_running: true, jobId: active.id }, { status: 409 });
    }

    let jobId: number;
    if (active) {
      // A pending row survived a crash — re-kick it instead of duplicating.
      jobId = active.id;
      log.info({ jobId }, "[reconcile-cron] Re-kicking pending reconcile job");
    } else {
      const [job] = db
        .insert(processingJobs)
        .values({
          jobType: JOB_TYPES.SHARED_DRIVES_RECONCILE,
          deploymentId: null,
          cameraTrapProjectId: null,
          status: "pending",
          totalImages: 0,
          processedImages: 0,
          failedImages: 0,
          statusMessage: "En cola (reconciliación de drives)...",
          createdBy: "cron@reconcile",
        })
        .returning()
        .all();
      jobId = job.id;
      log.info({ jobId }, "[reconcile-cron] Enqueued reconcile job");
    }

    await runReconciliationJob(jobId);
    return Response.json({ ok: true, jobId });
  } catch (err) {
    log.error({ err }, "[reconcile-cron] Fatal error");
    return Response.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}
