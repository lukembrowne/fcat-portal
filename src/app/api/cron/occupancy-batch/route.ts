/**
 * Cron endpoint: enqueue the weekly occupancy modeling batch.
 *
 * Refits every eligible species × stream (see src/lib/occupancy/build-run.ts).
 * Auth: Bearer CRON_SECRET only (timing-safe). We intentionally do NOT add an
 * X-Forwarded-For guard — the in-container localhost cron call carries XFF, so
 * that guard silently 403s the legitimate nightly job (same gotcha as the
 * reconcile-shared-drives route). Single-flight: never stacks a second batch.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { processingJobs } from "@/db/schema";
import { verifyCronSecret } from "@/lib/cron-auth";
import { JOB_TYPES } from "@/lib/job-types";
import { processNextQueueable } from "@/lib/job-queue";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!verifyCronSecret(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const active = await db
      .select({ id: processingJobs.id })
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.jobType, JOB_TYPES.OCCUPANCY_MODEL),
          inArray(processingJobs.status, ["pending", "processing"]),
        ),
      )
      .limit(1);
    if (active.length > 0) {
      return Response.json({ already_running: true, jobId: active[0].id }, { status: 409 });
    }

    const [job] = await db
      .insert(processingJobs)
      .values({
        jobType: JOB_TYPES.OCCUPANCY_MODEL,
        status: "pending",
        createdBy: "cron@occupancy",
        statusMessage: "En cola (modelos de ocupación)...",
      })
      .returning();

    void processNextQueueable().catch((err) =>
      log.error({ err, jobId: job.id }, "[occupancy-cron] Queue advance failed after enqueue"),
    );
    return Response.json({ enqueued: true, jobId: job.id });
  } catch (err) {
    log.error({ err }, "[occupancy-cron] failed");
    return Response.json({ error: "failed" }, { status: 500 });
  }
}
