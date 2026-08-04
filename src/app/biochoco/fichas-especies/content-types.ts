/**
 * Shared constants + types for the species-content editor.
 *
 * Kept OUT of actions.ts because that file is "use server": a Server Actions
 * module may only export async functions, so a runtime `const` export there
 * breaks the whole module at build time (Turbopack reports "no exports at
 * all"). Types + constants live here and are imported by both the actions and
 * the client component.
 */

/** Cap on the content field — long enough for a paragraph + a few tips. */
export const SPECIES_CONTENT_MAX = 2000;

export interface SpeciesContentRow {
  id: number;
  scientificName: string;
  commonName: string;
  spanishName: string | null;
  type: string;
  /** One free-text field: role in the forest + optional management tip. */
  publicContent: string | null;
  /** Verified/corrected detections of this species (across the DB) — for prioritizing. */
  detectionCount: number;
  hasContent: boolean;
  /**
   * Image of this species' highest-confidence verified/corrected identification,
   * shown as the card thumbnail. Null when the species has no verified
   * detections. Served through `/api/ct-images/{id}?size=thumb`, which gates on
   * camera-trap project access — so the card must degrade gracefully when a
   * biochoco-only editor gets a 403.
   */
  representativeImageId: number | null;
}
