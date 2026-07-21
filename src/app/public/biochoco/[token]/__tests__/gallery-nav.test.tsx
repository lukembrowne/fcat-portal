/**
 * U10 — desktop gallery arrows + adjacent-image preloading.
 *
 * The Vitest environment here is `node` with no jsdom/RTL available, so a full
 * component render is impractical. Instead we test the pure helpers that the
 * two components delegate to: `adjacentPreloadUrls` produces the EXACT URLs the
 * gallery feeds to `preloadImage`, and `lightboxArrowState` /
 * LIGHTBOX_*_LABEL drive the lightbox arrow buttons. (Deviation from the
 * plan's "render" wording is noted in the task report.)
 */

import { describe, expect, it, vi } from "vitest";

// Mock the preloader so importing the gallery module is side-effect-free and to
// document that these URLs are what would be passed to preloadImage.
vi.mock("@/lib/annotation-prefetch", () => ({
  preloadImage: vi.fn(() => ({ cancel: vi.fn() })),
}));

import { adjacentPreloadUrls } from "../especies/[slug]/gallery-client";
import {
  lightboxArrowState,
  LIGHTBOX_PREV_LABEL,
  LIGHTBOX_NEXT_LABEL,
} from "../species-lightbox";
import type { SpeciesImageRow } from "@/app/biochoco/resultados/actions";

const TOKEN = "abc123";

function makeImages(ids: number[]): SpeciesImageRow[] {
  return ids.map((id) => ({ id, filename: `IMG_${id}.jpg` })) as SpeciesImageRow[];
}

const url = (id: number) =>
  `/api/public/site-images/${TOKEN}/${id}?size=large`;

describe("adjacentPreloadUrls (gallery preloading contract)", () => {
  const images = makeImages([10, 20, 30, 40]);

  it("returns both neighbours for a middle image", () => {
    expect(adjacentPreloadUrls(TOKEN, images, 1)).toEqual({
      prev: url(10),
      next: url(30),
    });
  });

  it("has no prev at the first image", () => {
    expect(adjacentPreloadUrls(TOKEN, images, 0)).toEqual({
      prev: null,
      next: url(20),
    });
  });

  it("has no next at the last image", () => {
    expect(adjacentPreloadUrls(TOKEN, images, images.length - 1)).toEqual({
      prev: url(30),
      next: null,
    });
  });

  it("returns nulls when nothing is open or index is out of range", () => {
    expect(adjacentPreloadUrls(TOKEN, images, null)).toEqual({
      prev: null,
      next: null,
    });
    expect(adjacentPreloadUrls(TOKEN, images, 99)).toEqual({
      prev: null,
      next: null,
    });
  });
});

describe("lightbox arrow affordances", () => {
  it("exposes the Spanish aria-labels used on the arrow buttons", () => {
    expect(LIGHTBOX_PREV_LABEL).toBe("Imagen anterior");
    expect(LIGHTBOX_NEXT_LABEL).toBe("Imagen siguiente");
  });

  it("shows both arrows in the middle", () => {
    expect(lightboxArrowState(2, 5)).toEqual({
      showPrev: true,
      showNext: true,
    });
  });

  it("hides prev at the start and next at the end", () => {
    expect(lightboxArrowState(0, 5)).toEqual({
      showPrev: false,
      showNext: true,
    });
    expect(lightboxArrowState(4, 5)).toEqual({
      showPrev: true,
      showNext: false,
    });
  });

  it("shows no arrows for a single image", () => {
    expect(lightboxArrowState(0, 1)).toEqual({
      showPrev: false,
      showNext: false,
    });
  });
});
