import { describe, it, expect } from "vitest";
import {
  resolveCuratedAudio,
  resolveCuratedImages,
} from "@/app/public/biochoco-overview/lib/snapshot-transforms";
import type {
  CuratedAudioClip,
  CuratedImage,
} from "@/app/public/biochoco-overview/lib/snapshot-types";

const img = (imageId: number): CuratedImage => ({
  imageId,
  speciesLabel: "Panthera onca",
  caption: { en: "Jaguar", es: "Jaguar" },
});
const clip = (audioId: number): CuratedAudioClip => ({
  audioId,
  speciesLabel: "Grallaria alleni",
  caption: { en: "Antpitta", es: "Gralaria" },
});

describe("resolveCuratedImages", () => {
  it("keeps only ids present in the valid set and reports drops", () => {
    const { images, droppedImageIds } = resolveCuratedImages(
      [img(1), img(2), img(3)],
      new Set([1, 3]),
    );
    expect(images.map((i) => i.imageId)).toEqual([1, 3]);
    expect(droppedImageIds).toEqual([2]);
  });

  it("drops everything when the valid set is empty (never throws)", () => {
    const { images, droppedImageIds } = resolveCuratedImages([img(9)], new Set());
    expect(images).toEqual([]);
    expect(droppedImageIds).toEqual([9]);
  });

  it("preserves captions on kept entries", () => {
    const { images } = resolveCuratedImages([img(1)], new Set([1]));
    expect(images[0].caption).toEqual({ en: "Jaguar", es: "Jaguar" });
  });
});

describe("resolveCuratedAudio", () => {
  it("keeps only ids present in the valid set and reports drops", () => {
    const { audio, droppedAudioIds } = resolveCuratedAudio(
      [clip(10), clip(11)],
      new Set([11]),
    );
    expect(audio.map((a) => a.audioId)).toEqual([11]);
    expect(droppedAudioIds).toEqual([10]);
  });
});
