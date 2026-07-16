import { describe, it, expect } from "vitest";
import {
  parsePageConfig,
  serializePageConfig,
  defaultConfigFromLegacy,
  FEATURED_PHOTOS_MAX,
  NOTE_MAX,
  SUMMARY_MAX,
  PAGE_CONFIG_VERSION,
  type PageConfig,
} from "@/lib/landowner/page-config";

describe("parsePageConfig", () => {
  it("round-trips a valid config", () => {
    const config: PageConfig = {
      version: PAGE_CONFIG_VERSION,
      blocks: [
        { type: "hero", imageId: 12 },
        { type: "summary", text: "Resumen" },
        { type: "note", text: "Gracias" },
        { type: "featuredPhotos", imageIds: [1, 2, 3] },
        { type: "featuredAudio", audioId: 99 },
        { type: "projectContext", enabled: true },
      ],
    };
    expect(parsePageConfig(serializePageConfig(config))).toEqual(config);
  });

  it("returns null for absent or malformed input", () => {
    expect(parsePageConfig(null)).toBeNull();
    expect(parsePageConfig(undefined)).toBeNull();
    expect(parsePageConfig("")).toBeNull();
    expect(parsePageConfig("{not json")).toBeNull();
    expect(parsePageConfig("[]")).toBeNull();
    expect(parsePageConfig(JSON.stringify({ version: 1 }))).toBeNull(); // no blocks
  });

  it("rejects an unsupported version", () => {
    expect(
      parsePageConfig(JSON.stringify({ version: 2, blocks: [] })),
    ).toBeNull();
  });

  it("drops unknown block types but keeps known ones in order", () => {
    const raw = JSON.stringify({
      version: 1,
      blocks: [
        { type: "note", text: "hola" },
        { type: "someFutureBlock", payload: 1 },
        { type: "hero", imageId: 5 },
      ],
    });
    expect(parsePageConfig(raw)).toEqual({
      version: 1,
      blocks: [
        { type: "note", text: "hola" },
        { type: "hero", imageId: 5 },
      ],
    });
  });

  it("dedupes and caps featured photo ids, dropping non-positive ints", () => {
    const raw = JSON.stringify({
      version: 1,
      blocks: [
        {
          type: "featuredPhotos",
          imageIds: [1, 1, 2, 0, -3, 2, "x", 3, 4, 5, 6, 7, 8],
        },
      ],
    });
    const parsed = parsePageConfig(raw);
    const block = parsed?.blocks[0];
    expect(block?.type).toBe("featuredPhotos");
    if (block?.type === "featuredPhotos") {
      expect(block.imageIds).toEqual([1, 2, 3, 4, 5, 6]);
      expect(block.imageIds.length).toBeLessThanOrEqual(FEATURED_PHOTOS_MAX);
    }
  });

  it("drops a featuredPhotos block whose imageIds is not an array", () => {
    const raw = JSON.stringify({
      version: 1,
      blocks: [{ type: "featuredPhotos", imageIds: "nope" }],
    });
    expect(parsePageConfig(raw)).toEqual({ version: 1, blocks: [] });
  });

  it("clamps over-long text", () => {
    const raw = JSON.stringify({
      version: 1,
      blocks: [
        { type: "note", text: "a".repeat(NOTE_MAX + 50) },
        { type: "summary", text: "b".repeat(SUMMARY_MAX + 50) },
      ],
    });
    const parsed = parsePageConfig(raw);
    expect((parsed?.blocks[0] as { text: string }).text.length).toBe(NOTE_MAX);
    expect((parsed?.blocks[1] as { text: string }).text.length).toBe(
      SUMMARY_MAX,
    );
  });

  it("coerces an invalid hero imageId to null", () => {
    const raw = JSON.stringify({
      version: 1,
      blocks: [{ type: "hero", imageId: "not-a-number" }],
    });
    expect(parsePageConfig(raw)).toEqual({
      version: 1,
      blocks: [{ type: "hero", imageId: null }],
    });
  });
});

describe("defaultConfigFromLegacy", () => {
  it("folds hero + note + audio into the default order", () => {
    expect(
      defaultConfigFromLegacy({
        heroImageId: 7,
        landownerNote: "  Gracias por cuidar el bosque  ",
        featuredAudioId: 42,
      }),
    ).toEqual({
      version: 1,
      blocks: [
        { type: "hero", imageId: 7 },
        { type: "note", text: "Gracias por cuidar el bosque" },
        { type: "featuredAudio", audioId: 42 },
      ],
    });
  });

  it("produces a hero-only config when there is no legacy curation", () => {
    expect(
      defaultConfigFromLegacy({
        heroImageId: null,
        landownerNote: null,
        featuredAudioId: null,
      }),
    ).toEqual({ version: 1, blocks: [{ type: "hero", imageId: null }] });
  });

  it("omits an empty/whitespace note", () => {
    const config = defaultConfigFromLegacy({
      heroImageId: 1,
      landownerNote: "   ",
      featuredAudioId: null,
    });
    expect(config.blocks.some((b) => b.type === "note")).toBe(false);
  });
});
