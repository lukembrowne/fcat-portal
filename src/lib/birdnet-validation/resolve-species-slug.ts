/**
 * Slug → species for the BirdNET validation species page only.
 *
 * Tries the shared `resolveSpeciesFromSlug` first, then falls back to species
 * a validation reviewer named as a clip's real identity
 * (`birdnet_validation_reviews.corrected_species`). That fallback deliberately
 * does NOT live in the shared resolver: `/camera-trap/species` and
 * `/audio/species` use it too, and a name only a reviewer has typed there would
 * render as a synthesized 'mammal' page instead of a 404.
 */

import "server-only";

import { isNotNull } from "drizzle-orm";

import { db } from "@/db";
import { birdnetValidationReviews, type Species } from "@/db/schema";
import { speciesSlug } from "@/lib/species-slug";
import { resolveSpeciesFromSlug } from "@/lib/species-slug-server";

/**
 * A minimal record for a reviewer-suggested species with no lookup-table row.
 * `id: -1` marks it synthesized (the page reads names from BirdNET's list);
 * it is a BirdNET label, hence `bird`.
 */
function synthesizeSuggested(scientificName: string): Species {
  return {
    id: -1,
    scientificName,
    commonName: scientificName,
    spanishName: null,
    taxonomicRank: "species",
    type: "bird",
    iucnStatus: null,
    cameraSelectable: false,
    publicContent: null,
  };
}

export async function resolveValidationSpeciesFromSlug(
  slug: string
): Promise<Species | null> {
  const shared = await resolveSpeciesFromSlug(slug);
  if (shared) return shared;

  const target = slug.toLowerCase();
  const suggested = await db
    .selectDistinct({ name: birdnetValidationReviews.correctedSpecies })
    .from(birdnetValidationReviews)
    .where(isNotNull(birdnetValidationReviews.correctedSpecies));
  for (const { name } of suggested) {
    if (name != null && speciesSlug(name) === target) return synthesizeSuggested(name);
  }
  return null;
}
