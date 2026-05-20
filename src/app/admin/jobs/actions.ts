"use server";

import { requireAdmin } from "@/lib/auth";
import { cancelProcessingJob } from "@/app/audio/actions";
import { processNextQueueable } from "@/lib/job-queue";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/types";

/**
 * Admin-only "cancel any job by id". Reuses `cancelProcessingJob` which
 * already dispatches by jobType (BirdNET / indices / audio-analysis / audio
 * compression / camera-trap) and emits the appropriate `.cancelled` event.
 *
 * After cancel, fires the unified queue picker so the next pending job
 * (if any) starts immediately.
 */
export async function cancelJobById(jobId: number): Promise<ActionResult> {
  await requireAdmin();

  const result = await cancelProcessingJob(jobId);

  // Best-effort queue advance — `cancelProcessingJob`'s inner cancel paths
  // already fire the picker, but firing one more time is a no-op when busy.
  void processNextQueueable().catch(() => {});

  revalidatePath("/admin/jobs");
  return result;
}
