import { describe, it, expect } from "vitest";
import {
  resolveSpeciesGallery,
  SPECIES_GALLERY_AUTO_LIMIT_THRESHOLD,
  SPECIES_GALLERY_AUTO_LIMIT_COUNT,
  type GalleryCandidate,
} from "../species-gallery";

/**
 * mk builds a candidate. `candidates` arrive newest-first from the query, so
 * these helpers produce descending time order by index unless overridden.
 */
function mk(
  id: number,
  opts: Partial<GalleryCandidate> = {}
): GalleryCandidate {
  return {
    id,
    filename: `IMG_${id}.jpg`,
    exifTimestamp: null,
    confidence: 0.5,
    starred: false,
    starredAt: null,
    ...opts,
  };
}

/** N unstarred candidates, ids 1..N, already newest-first. */
function many(n: number, opts: Partial<GalleryCandidate> = {}): GalleryCandidate[] {
  return Array.from({ length: n }, (_, i) => mk(i + 1, opts));
}

describe("resolveSpeciesGallery", () => {
  it("returns ONLY starred photos when any are starred, newest star first", () => {
    const candidates = [
      mk(1, { starred: true, starredAt: 100 }),
      ...many(200).map((c) => mk(c.id + 10)), // 200 unstarred
      mk(2, { starred: true, starredAt: 300 }),
      mk(3, { starred: true, starredAt: 200 }),
    ];
    const res = resolveSpeciesGallery(candidates);
    expect(res.mode).toBe("starred");
    expect(res.images.map((i) => i.id)).toEqual([2, 3, 1]); // by starredAt desc
    expect(res.totalAvailable).toBe(203);
  });

  it("shows ALL photos when none starred and count ≤ threshold", () => {
    const candidates = many(8);
    const res = resolveSpeciesGallery(candidates);
    expect(res.mode).toBe("all");
    expect(res.images).toHaveLength(8);
    expect(res.totalAvailable).toBe(8);
  });

  it("caps to the highest-confidence sample when none starred and count > threshold", () => {
    // 40 candidates; give ids 5,6,7,8,9,10 the top confidence.
    const candidates = many(40).map((c) =>
      [5, 6, 7, 8, 9, 10].includes(c.id)
        ? { ...c, confidence: 0.9 }
        : { ...c, confidence: 0.1 }
    );
    const res = resolveSpeciesGallery(candidates);
    expect(res.mode).toBe("capped");
    expect(res.images).toHaveLength(SPECIES_GALLERY_AUTO_LIMIT_COUNT);
    expect(res.images.map((i) => i.id).sort((a, b) => a - b)).toEqual([
      5, 6, 7, 8, 9, 10,
    ]);
    // Displayed newest-first: candidates are newest-first by index, so the
    // capped sample preserves ascending original position (id 5 before id 10).
    expect(res.images.map((i) => i.id)).toEqual([5, 6, 7, 8, 9, 10]);
    expect(res.totalAvailable).toBe(40);
  });

  it("boundary: exactly threshold shows all; threshold+1 caps", () => {
    const atThreshold = resolveSpeciesGallery(
      many(SPECIES_GALLERY_AUTO_LIMIT_THRESHOLD)
    );
    expect(atThreshold.mode).toBe("all");
    expect(atThreshold.images).toHaveLength(SPECIES_GALLERY_AUTO_LIMIT_THRESHOLD);

    const overThreshold = resolveSpeciesGallery(
      many(SPECIES_GALLERY_AUTO_LIMIT_THRESHOLD + 1)
    );
    expect(overThreshold.mode).toBe("capped");
    expect(overThreshold.images).toHaveLength(SPECIES_GALLERY_AUTO_LIMIT_COUNT);
  });

  it("handles the empty set", () => {
    const res = resolveSpeciesGallery([]);
    expect(res.mode).toBe("all");
    expect(res.images).toHaveLength(0);
    expect(res.totalAvailable).toBe(0);
  });

  it("a single starred photo wins even against a large unstarred pool", () => {
    const candidates = [mk(99, { starred: true, starredAt: 5 }), ...many(500)];
    const res = resolveSpeciesGallery(candidates);
    expect(res.mode).toBe("starred");
    expect(res.images).toEqual([candidates[0]]);
  });
});
