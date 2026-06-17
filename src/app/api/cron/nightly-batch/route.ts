/**
 * Cron endpoint: overnight audio batch processor.
 *
 * Fires at 10pm Ecuador (see scripts/crontab). Selects never-processed, settled
 * audio deployments (oldest-data-first), re-counts each one's Drive folder live
 * to skip in-progress uploads, and enqueues BirdNET + acoustic-indices jobs.
 * The unified queue drains them overnight; the picker's window gate stops
 * starting new batch jobs after 6am.
 *
 * Auth: Bearer CRON_SECRET (timing-safe). No X-Forwarded-For guard — it blocks
 * in-container localhost cron.
 *
 * Plan: docs/plans/2026-06-17-feat-overnight-batch-audio-processing-plan.md
 */

import { verifyCronSecret } from "@/lib/cron-auth";
import { runNightlyAudioBatch } from "@/lib/audio-batch";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!verifyCronSecret(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runNightlyAudioBatch();
    return Response.json({ ok: true, ...result });
  } catch (err) {
    log.error({ err }, "[nightly-batch] route failed");
    const message = err instanceof Error ? err.message : "Error desconocido";
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
