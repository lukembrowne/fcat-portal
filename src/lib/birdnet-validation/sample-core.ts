/**
 * The stratified draw, without permission or routing concerns.
 *
 * Lives outside `actions.ts` so three callers can share it: creating one
 * species, creating many through the bulk importer, and re-running a draw that
 * failed the first time. The bulk path runs it once per created species inside
 * ONE server action, which matters twice over:
 *
 *  - `loadSiteHabitatMap` is wrapped in `React.cache`, so every iteration
 *    inside that single request shares one ODK round-trip. Looping over a
 *    server action instead would pay the ODK cost per species.
 *  - This throws instead of returning a result, so the bulk caller can catch
 *    per species and keep going. One species failing — ODK down, no accessible
 *    detections — must not roll back the other four.
 *
 * Cost, measured end to end against the dev database: 1.4-2.0 s per species,
 * and nearly flat in how common the species is. The floor is ~170 ms per score
 * bin — nine windowed queries each paying the species-index scan on a 2.5M-row
 * table — so a species with 93 detections costs about what one with 25,000
 * does. That flatness is why the importer's chunk size is the only lever
 * available; there is no cheap species to batch more of.
 */

import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { birdnetValidationCampaigns, birdnetValidationSamples } from "@/db/schema";
import { loadSiteHabitatMap } from "@/lib/habitat-lookup";
import { log } from "@/lib/log";
import {
  drawStratifiedSample,
  presentationOrder,
  type SampleCandidate,
} from "./sampling";

/**
 * Attach the ODK habitat snapshot to drawn candidates.
 *
 * Habitat is reporting metadata, never a sampling quota — ODK can be down, and
 * a failed lookup must not block a draw. Degrades to nulls with a warning.
 */
export async function attachHabitat(
  candidates: SampleCandidate[]
): Promise<Array<SampleCandidate & { habitat: string | null }>> {
  let habitatMap = new Map<string, string>();
  try {
    habitatMap = await loadSiteHabitatMap();
  } catch (err) {
    log.warn({ err }, "[birdnet-validation] habitat lookup failed; sampling without it");
  }
  return candidates.map((c) => ({
    ...c,
    habitat: c.siteName ? (habitatMap.get(c.siteName) ?? null) : null,
  }));
}

export interface DrawResult {
  inserted: number;
  /** Per-bin availability, for reporting the realised design. */
  available: number[];
  /** Per-bin target from allocateBins. */
  allocated: number[];
}

/**
 * Draw and insert a species' stratified sample.
 *
 * The draw runs BEFORE the transaction: better-sqlite3 transactions are
 * synchronous and cannot await, and the habitat lookup is an ODK round-trip.
 *
 * Throws with a Spanish message on failure; `errorResult` surfaces
 * `error.message` verbatim, so callers return the same strings they always did.
 */
export async function drawSampleCore(
  campaign: typeof birdnetValidationCampaigns.$inferSelect,
  ctProjects: number[] | "all"
): Promise<DrawResult> {
  if (campaign.status === "abandoned") {
    throw new Error("Esta validación fue descartada");
  }
  if (campaign.sampledAt) {
    throw new Error("La muestra ya fue extraída");
  }

  // Normally empty — a campaign either has its sample or has nothing. Kept
  // because the unique index on (campaign_id, audio_identification_id) turns a
  // re-draw over existing rows into a constraint error rather than a message.
  const priorRows = await db
    .select({ identId: birdnetValidationSamples.audioIdentificationId })
    .from(birdnetValidationSamples)
    .where(eq(birdnetValidationSamples.campaignId, campaign.id));
  const excludeIds = priorRows.map((r) => r.identId);

  const { candidates, available, allocated } = await drawStratifiedSample({
    species: campaign.species,
    ctProjects,
    binCount: campaign.binCount,
    target: campaign.targetSampleSize,
    seed: campaign.seed,
    excludeIds,
  });

  if (candidates.length === 0) {
    throw new Error("No hay detecciones de esta especie en los proyectos accesibles");
  }

  const withHabitat = await attachHabitat(candidates);
  // `drawStratifiedSample` emits bin by bin ascending. Using that as queue
  // order would walk the reviewer from the worst clips to the best — see
  // `presentationOrder`.
  const ordered = presentationOrder(withHabitat, campaign.seed);
  const offset = excludeIds.length;

  db.transaction((tx) => {
    ordered.forEach((c, i) => {
      tx.insert(birdnetValidationSamples)
        .values({
          campaignId: campaign.id,
          audioIdentificationId: c.audioIdentificationId,
          confidence: c.confidence,
          binIndex: c.binIndex,
          deploymentId: c.deploymentId,
          siteName: c.siteName,
          habitat: c.habitat,
          orderIndex: offset + i,
        })
        .run();
    });
    tx.update(birdnetValidationCampaigns)
      .set({ status: "sampled", sampledAt: new Date() })
      .where(eq(birdnetValidationCampaigns.id, campaign.id))
      .run();
  });

  return { inserted: ordered.length, available, allocated };
}
