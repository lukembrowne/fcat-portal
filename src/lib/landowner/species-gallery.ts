/**
 * Per-species photo gallery resolution for the public finca pages.
 *
 * The public per-species gallery used to show EVERY verified image of a
 * species, which is overwhelming when a species has hundreds of records. This
 * pure resolver picks the subset to display, in priority order:
 *
 *   1. `starred`  — if the team hand-picked (starred) any photos of the
 *                   species, show ONLY those (the "destacadas"), newest star
 *                   first. Curation always wins.
 *   2. `all`      — no starred photos and few total (≤ threshold): show all.
 *   3. `capped`   — no starred photos and many total (> threshold): show a
 *                   representative sample — the highest-confidence photos,
 *                   displayed newest-first.
 *
 * Kept pure (no DB) so the branch logic is unit-testable. The DB fetch +
 * pagination live in `fetchSpeciesGalleryImages` in the resultados actions.
 */

/** Below-or-equal this many photos (and none starred) → show all of them. */
export const SPECIES_GALLERY_AUTO_LIMIT_THRESHOLD = 10;
/** Above the threshold (and none starred) → show this many best photos. */
export const SPECIES_GALLERY_AUTO_LIMIT_COUNT = 6;

export type GalleryMode = "starred" | "all" | "capped";

export interface GalleryCandidate {
  id: number;
  filename: string;
  exifTimestamp: string | null;
  /** Best identification confidence for this image (0–1). */
  confidence: number;
  starred: boolean;
  /** Epoch when starred (any unit — used only for relative ordering); null if not starred. */
  starredAt: number | null;
}

export interface ResolvedGallery {
  images: GalleryCandidate[];
  mode: GalleryMode;
  /** Verified images available for the species before curation/capping. */
  totalAvailable: number;
}

/**
 * Resolve which photos to show for a species.
 *
 * `candidates` MUST arrive already ordered newest-first (the SQL orders by
 * `coalesce(exif_timestamp, file_modified) DESC`). The `all` and `capped`
 * branches preserve that order for display; `starred` re-orders by star recency.
 */
export function resolveSpeciesGallery(
  candidates: GalleryCandidate[]
): ResolvedGallery {
  const totalAvailable = candidates.length;

  const starred = candidates.filter((c) => c.starred);
  if (starred.length > 0) {
    // Newest star first; stable id tiebreaker.
    const images = [...starred].sort(
      (a, b) =>
        (b.starredAt ?? 0) - (a.starredAt ?? 0) || b.id - a.id
    );
    return { images, mode: "starred", totalAvailable };
  }

  if (totalAvailable <= SPECIES_GALLERY_AUTO_LIMIT_THRESHOLD) {
    // Already newest-first from the query.
    return { images: [...candidates], mode: "all", totalAvailable };
  }

  // Many photos, none curated: keep the highest-confidence sample, but display
  // it newest-first (restore original position after the confidence sort).
  const position = new Map(candidates.map((c, i) => [c.id, i]));
  const images = [...candidates]
    .sort((a, b) => b.confidence - a.confidence || a.id - b.id)
    .slice(0, SPECIES_GALLERY_AUTO_LIMIT_COUNT)
    .sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));

  return { images, mode: "capped", totalAvailable };
}
