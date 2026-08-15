/**
 * Which camera-trap identifications count as a wild species.
 *
 * Two rules, historically applied in different places and duplicated across
 * files: an identification must map to a real species (not a bucket class like
 * `Aves` or `Rodentia`, not a system entry like `Unknown`), and it must not be a
 * domestic animal. The public BioChoco overview carried the domestic set twice —
 * once in its PDF route, once in its page shell — and the real-species predicate
 * lived in the snapshot transforms. Any new consumer made it three copies.
 *
 * Everything outward-facing now shares this module: the public overview page and
 * download, and the Choconexión bundle export.
 */

/** Metadata for one species, as stored in `biochoco_species`. */
export interface SpeciesTypeMeta {
  type: string;
  taxonomicRank: string | null;
}

/**
 * Domestic animals excluded from wild-species lists and counts.
 *
 * These are real species-rank rows in the lookup — a horse is not a bucket
 * class — so the real-species predicate alone does not remove them. They are
 * excluded from *wild* species reporting, not deleted from the data: a dog on a
 * camera is a genuine observation, just not a result about forest recovery.
 */
export const DOMESTIC: ReadonlySet<string> = new Set([
  "Gallus gallus domesticus",
  "Canis lupus familiaris",
  "Bos taurus",
  "Anas platyrhynchos domesticus",
  "Equus caballus",
  "Felis catus",
  "Sus scrofa domesticus",
]);

/**
 * A row counts as a real species only if it maps to a non-system entry at
 * species rank. This drops "Unknown"/"Homo sapiens" (system) and higher-taxa
 * labels like "Aves" (class), "Rodentia" (order), "Leptotila sp." (genus).
 */
export function isRealSpecies<T extends SpeciesTypeMeta>(
  meta: T | undefined,
): meta is T {
  return (
    !!meta &&
    meta.type !== "system" &&
    (!meta.taxonomicRank || meta.taxonomicRank === "species")
  );
}

/** Whether this scientific name is a domestic animal. */
export function isDomestic(scientificName: string): boolean {
  return DOMESTIC.has(scientificName);
}

/**
 * Both rules at once: a real species that is not domestic.
 *
 * An identification whose scientific name is absent from the species lookup
 * fails, because `meta` is undefined — an unrecognised label is never reported
 * as a wild species.
 */
export function isWildSpecies<T extends SpeciesTypeMeta>(
  meta: T | undefined,
  scientificName: string,
): meta is T {
  return isRealSpecies(meta) && !isDomestic(scientificName);
}
