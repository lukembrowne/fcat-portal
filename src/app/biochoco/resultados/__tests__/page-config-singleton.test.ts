/**
 * U2 — "Fotos destacadas" is a singleton, and featured-photo ids are gated by
 * the token's deployment snapshot.
 *
 * These pure helpers are shared by the save sanitizer (updateSitePageConfig)
 * and the public resolver (resolveContentBlocks), so locking them in here
 * covers both paths without a DB:
 *  - enforceFeaturedPhotosSingleton: two featuredPhotos blocks collapse to one.
 *  - validateFeaturedPhotoIds: ids in the snapshot survive (block resolves
 *    non-empty); ids outside the snapshot are dropped (block resolves empty
 *    → not rendered).
 */

import { describe, it, expect } from "vitest";
import {
  enforceFeaturedPhotosSingleton,
  validateFeaturedPhotoIds,
  PAGE_CONFIG_VERSION,
  type PageConfig,
} from "@/lib/landowner/page-config";

describe("enforceFeaturedPhotosSingleton", () => {
  it("keeps exactly one featuredPhotos block (the first) and drops the rest", () => {
    const config: PageConfig = {
      version: PAGE_CONFIG_VERSION,
      blocks: [
        { type: "hero", imageId: 1 },
        { type: "featuredPhotos", imageIds: [10, 11] },
        { type: "note", text: "hola" },
        { type: "featuredPhotos", imageIds: [20, 21] },
        { type: "featuredPhotos", imageIds: [30] },
      ],
    };
    const out = enforceFeaturedPhotosSingleton(config);
    const photos = out.blocks.filter((b) => b.type === "featuredPhotos");
    expect(photos).toHaveLength(1);
    // The FIRST block (its imageIds) is the survivor.
    expect(photos[0]).toEqual({ type: "featuredPhotos", imageIds: [10, 11] });
  });

  it("preserves the order and content of every other block", () => {
    const config: PageConfig = {
      version: PAGE_CONFIG_VERSION,
      blocks: [
        { type: "hero", imageId: 1 },
        { type: "featuredPhotos", imageIds: [10] },
        { type: "note", text: "primero" },
        { type: "featuredPhotos", imageIds: [20] },
        { type: "featuredAudio", audioId: 99 },
      ],
    };
    const out = enforceFeaturedPhotosSingleton(config);
    expect(out.blocks.map((b) => b.type)).toEqual([
      "hero",
      "featuredPhotos",
      "note",
      "featuredAudio",
    ]);
  });

  it("is a no-op when there is at most one featuredPhotos block", () => {
    const config: PageConfig = {
      version: PAGE_CONFIG_VERSION,
      blocks: [
        { type: "hero", imageId: 1 },
        { type: "featuredPhotos", imageIds: [10, 11] },
        { type: "note", text: "hola" },
      ],
    };
    expect(enforceFeaturedPhotosSingleton(config)).toEqual(config);
  });
});

describe("validateFeaturedPhotoIds (snapshot gate)", () => {
  it("keeps only ids present in the deployment snapshot, in order", () => {
    const valid = new Set([10, 11, 12]);
    expect(validateFeaturedPhotoIds([10, 11, 12], valid)).toEqual([10, 11, 12]);
  });

  it("resolves to empty (block not rendered) when no id is in the snapshot", () => {
    const valid = new Set([500, 501]); // another site's images
    expect(validateFeaturedPhotoIds([10, 11], valid)).toEqual([]);
  });

  it("drops the stray ids but keeps the valid ones", () => {
    const valid = new Set([10, 12]);
    expect(validateFeaturedPhotoIds([10, 11, 12, 999], valid)).toEqual([10, 12]);
  });
});
