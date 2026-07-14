import "server-only";
import { db } from "@/db";
import { publicReportSnapshots } from "@/db/schema";
import { eq } from "drizzle-orm";
import { log } from "@/lib/log";
import type { ReportSnapshot } from "@/app/public/biochoco-overview/lib/snapshot-types";

/** Slug of the BioChoco public overview page (route + snapshot key). */
export const BIOCHOCO_OVERVIEW_SLUG = "biochoco-overview";

/**
 * Read the active snapshot for a slug, or null if none has been published yet
 * (or the stored payload is unparseable — logged, never thrown, so a bad row
 * degrades to the page's "coming soon" state rather than a 500).
 */
export async function getActiveReportSnapshot(
  slug: string = BIOCHOCO_OVERVIEW_SLUG,
): Promise<ReportSnapshot | null> {
  const [row] = await db
    .select({ payload: publicReportSnapshots.payload })
    .from(publicReportSnapshots)
    .where(eq(publicReportSnapshots.slug, slug));

  if (!row) return null;
  try {
    return JSON.parse(row.payload) as ReportSnapshot;
  } catch (err) {
    log.warn({ err, slug }, "[public-report] active snapshot payload is unparseable");
    return null;
  }
}

/**
 * Upsert the active snapshot for its slug. One row per slug — publishing again
 * replaces the previous payload atomically (single INSERT ... ON CONFLICT).
 */
export async function saveReportSnapshot(snapshot: ReportSnapshot): Promise<void> {
  const payload = JSON.stringify(snapshot);
  await db
    .insert(publicReportSnapshots)
    .values({
      slug: snapshot.slug,
      payload,
      generatedAt: new Date(),
      generatedBy: snapshot.generatedBy,
    })
    .onConflictDoUpdate({
      target: publicReportSnapshots.slug,
      set: { payload, generatedAt: new Date(), generatedBy: snapshot.generatedBy },
    });
}

/** Image ids the active snapshot has published — the public image route's allowlist. */
export async function getReportImageAllowlist(
  slug: string = BIOCHOCO_OVERVIEW_SLUG,
): Promise<Set<number>> {
  const snapshot = await getActiveReportSnapshot(slug);
  return new Set(snapshot?.images.map((i) => i.imageId) ?? []);
}

/** Audio ids the active snapshot has published — the public audio route's allowlist. */
export async function getReportAudioAllowlist(
  slug: string = BIOCHOCO_OVERVIEW_SLUG,
): Promise<Set<number>> {
  const snapshot = await getActiveReportSnapshot(slug);
  return new Set(snapshot?.audio.map((a) => a.audioId) ?? []);
}
