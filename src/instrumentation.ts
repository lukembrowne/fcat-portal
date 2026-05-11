/**
 * Next.js boot hook — runs once per server lifecycle (Node runtime only).
 *
 * On startup we:
 *   1. Force the DB singleton to init (also runs the integrity check).
 *   2. Reset any jobs left in `processing` from a previous run back to
 *      `pending` so they resume on the unfinished images.
 *   3. Kick the queue so the first pending job starts. Each job's success
 *      path advances the queue itself, so this single nudge drains the lot.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { recoverStuckJobs } = await import("@/db");
  recoverStuckJobs();

  const { processNextInQueue } = await import("@/app/camera-trap/actions");
  const { log } = await import("@/lib/log");

  processNextInQueue().catch((err) => {
    log.error({ err }, "[instrumentation] Failed to advance queue on startup");
  });
}
