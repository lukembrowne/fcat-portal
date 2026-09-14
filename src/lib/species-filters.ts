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

// ---------------------------------------------------------------------------
// Humans
// ---------------------------------------------------------------------------

/**
 * Labels that identify a person rather than an animal.
 *
 * `isRealSpecies` already drops "Homo sapiens" wherever the species lookup is
 * joined, because the row carries `type = 'system'`. Three things make that
 * insufficient as the only guard against exporting pictures of people:
 *
 *  1. Not every consumer joins the lookup. The training-dataset exporter works
 *     on raw label strings (`corrected_species ?? species`) and never reads
 *     `biochoco_species` at all, so nothing in it could see the `system` type.
 *  2. `type` is editable data, not code. Someone re-typing that row to
 *     `mammal` — which is, taxonomically, not wrong — would silently re-admit
 *     human crops everywhere the lookup is the only check.
 *  3. Imported corpora bring their own vocabulary. LILA/COCO-Camera-Traps and
 *     MegaDetector call the class `person` or `human`; none of those strings
 *     exists in `biochoco_species`, so `isRealSpecies` returns false for the
 *     absent-meta reason rather than the human reason, and a future importer
 *     that inserts its labels would get no protection at all.
 *
 * So the human rule is a denylist over the label itself, independent of any
 * table. Matching is exact against the normalized form rather than substring,
 * so a genuine taxon that merely contains a human-ish string — `Homoptera`,
 * `Pachyramphus homochrous` — is never caught by it.
 */
const HUMAN_LABELS: ReadonlySet<string> = new Set([
  "homo",
  "human",
  "humans",
  "human being",
  "humano",
  "humanos",
  "humana",
  "person",
  "persons",
  "personas",
  "persona",
  "people",
  "gente",
]);

/**
 * Case-, accent- and punctuation-insensitive form used for label comparison.
 * "Homo sapiens (Human)" and "homo_sapiens" both normalize to "homo sapiens".
 */
function normalizeLabel(label: string): string {
  return label
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining marks before the alnum collapse
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Whether this label denotes a human.
 *
 * Covers the genus prefix as well as the exact denylist, so every binomial and
 * trinomial under `Homo` is caught — `Homo sapiens`, `Homo sapiens sapiens`,
 * `Homo neanderthalensis` — without the prefix rule reaching into unrelated
 * names that merely begin with the same letters (`Homoptera` normalizes to one
 * word, so it neither equals "homo" nor starts with "homo ").
 */
export function isHumanLabel(label: string): boolean {
  const n = normalizeLabel(label);
  if (!n) return false;
  return n === "homo" || n.startsWith("homo ") || HUMAN_LABELS.has(n);
}
