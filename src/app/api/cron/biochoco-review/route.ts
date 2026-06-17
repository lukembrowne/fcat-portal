/**
 * Cron / on-demand endpoint: BioChoco monthly data-quality review snapshot.
 *
 * Runs the review engine (`buildReviewSnapshot`) inside the live server — where
 * all runtime deps, the DB, and Drive/Sheets/ODK credentials are available — and
 * returns the snapshot JSON. The `biochoco-data-review` skill triggers this in
 * production (via scripts/run-biochoco-review.mjs inside the container) and then
 * authors the Spanish report from the JSON.
 *
 * By default it does NOT force a live Drive re-count: the nightly-refresh cron
 * already keeps counts ~24h fresh, which is accurate enough for a monthly review.
 * Pass `?recount=true` to force a live re-count (slow — minutes).
 *
 * Auth: Bearer CRON_SECRET (timing-safe), matching the other cron routes
 * (nightly-refresh, portal-updates, …). The secret is the security boundary; we
 * intentionally do NOT add an X-Forwarded-For guard — in this deployment the
 * in-container localhost:3000 call already carries XFF, so that guard would
 * reject the legitimate trigger.
 *
 * Plan: docs/plans/2026-06-16-feat-biochoco-data-quality-review-skill-plan.md
 */

import { verifyCronSecret } from "@/lib/cron-auth";
import { buildReviewSnapshot, ecuadorToday } from "@/lib/biochoco-review-core";
import { recordEvent } from "@/lib/system-events";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
// Force re-count can take minutes; give the route room (cached path is seconds).
export const maxDuration = 800;

async function handle(request: Request): Promise<Response> {
  if (!verifyCronSecret(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const recount = url.searchParams.get("recount") === "true";
  const today = url.searchParams.get("today") ?? ecuadorToday();

  try {
    const startedAt = Date.now();
    const snapshot = await buildReviewSnapshot({ today, recount });
    const durationMs = Date.now() - startedAt;
    const s = snapshot.summary;

    const severity = s.error > 0 ? "error" : s.warn > 0 ? "warn" : "success";
    await recordEvent({
      source: "cron",
      eventType: "cron_biochoco_review",
      severity,
      summary: `Revisión de datos BioChocó: ${s.error} errores, ${s.warn} advertencias, ${s.info} informativos`,
      durationMs,
      details: {
        today,
        recount,
        totals: snapshot.totals,
        byCheck: s.byCheck,
      },
    });

    return Response.json(snapshot);
  } catch (err) {
    log.error({ err }, "[biochoco-review-cron] Fatal error");
    return Response.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export const POST = handle;
export const GET = handle;
