/**
 * Server-only reverse-lookup for species slugs.
 *
 * Strategy:
 *   1. Try the species lookup table (fast path; covers everything with a
 *      human-curated display name).
 *   2. If no match, scan distinct names from identifications + audio
 *      identifications. Aggregator-fed pages include genus-only labels like
 *      "Dasyprocta" that don't have a species-table row but ARE detection
 *      labels — without this fallback those rows would 404 from the index.
 *   3. If a fallback name matches, synthesize a minimal Species record so
 *      the detail page can render. The "common name" falls back to the
 *      scientific name in that case.
 *
 * Returns null when 0 names slugify to the target (caller renders notFound).
 */

import "server-only";

import { isNotNull } from "drizzle-orm";
import { db } from "@/db";
import {
  species,
  identifications,
  audioIdentifications,
} from "@/db/schema";
import type { Species } from "@/db/schema";
import { speciesSlug } from "./species-slug";

function synthesize(scientificName: string): Species {
  return {
    id: -1,
    scientificName,
    commonName: scientificName,
    spanishName: null,
    taxonomicRank: "species",
    type: "mammal",
    iucnStatus: null,
  };
}

export async function resolveSpeciesFromSlug(
  slug: string
): Promise<Species | null> {
  const target = slug.toLowerCase();

  // Fast path — species lookup table.
  const speciesRows = await db.select().from(species);
  const direct = speciesRows.find(
    (s) => speciesSlug(s.scientificName) === target
  );
  if (direct) return direct;

  // Fallback — scan distinct identification names across both modules.
  const ctSpeciesNames = await db
    .selectDistinct({ name: identifications.species })
    .from(identifications)
    .where(isNotNull(identifications.species));
  const ctCorrected = await db
    .selectDistinct({ name: identifications.correctedSpecies })
    .from(identifications)
    .where(isNotNull(identifications.correctedSpecies));
  const audioSpeciesNames = await db
    .selectDistinct({ name: audioIdentifications.species })
    .from(audioIdentifications)
    .where(isNotNull(audioIdentifications.species));
  const audioCorrected = await db
    .selectDistinct({ name: audioIdentifications.correctedSpecies })
    .from(audioIdentifications)
    .where(isNotNull(audioIdentifications.correctedSpecies));

  const seen = new Set<string>();
  for (const r of [
    ...ctSpeciesNames,
    ...ctCorrected,
    ...audioSpeciesNames,
    ...audioCorrected,
  ]) {
    if (r.name == null) continue;
    if (seen.has(r.name)) continue;
    seen.add(r.name);
    if (speciesSlug(r.name) === target) return synthesize(r.name);
  }

  return null;
}
