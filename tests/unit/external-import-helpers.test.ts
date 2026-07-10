import { describe, it, expect } from "vitest";
import {
  pickBestAnimalDetection,
  resolveCapByClass,
} from "@/lib/external/import-job";
import { EXTERNAL_CAP_PER_CLASS } from "@/lib/external/taxon-map";

describe("pickBestAnimalDetection", () => {
  it("returns the highest-confidence animal detection", () => {
    const best = pickBestAnimalDetection([
      { id: 1, detectionClass: 0, detectionConfidence: 0.5 },
      { id: 2, detectionClass: 0, detectionConfidence: 0.9 },
      { id: 3, detectionClass: 1, detectionConfidence: 0.99 }, // person
    ]);
    expect(best?.id).toBe(2);
  });

  it("ignores non-animal classes and returns null when none", () => {
    expect(
      pickBestAnimalDetection([
        { id: 1, detectionClass: 1, detectionConfidence: 0.9 }, // person
        { id: 2, detectionClass: 2, detectionConfidence: 0.8 }, // vehicle
      ]),
    ).toBeNull();
    expect(pickBestAnimalDetection([])).toBeNull();
  });

  it("breaks confidence ties by lowest id (deterministic)", () => {
    const best = pickBestAnimalDetection([
      { id: 5, detectionClass: 0, detectionConfidence: 0.7 },
      { id: 2, detectionClass: 0, detectionConfidence: 0.7 },
    ]);
    expect(best?.id).toBe(2);
  });
});

describe("resolveCapByClass", () => {
  it("assigns the flat per-class cap to every requested class", () => {
    const caps = resolveCapByClass(["Mazama sp.", "Leopardus pardalis"]);
    expect(caps.get("Mazama sp.")).toBe(EXTERNAL_CAP_PER_CLASS);
    expect(caps.get("Leopardus pardalis")).toBe(EXTERNAL_CAP_PER_CLASS);
  });

  it("omits classes that were not requested", () => {
    const caps = resolveCapByClass(["Eira barbara"]);
    expect(caps.has("Tamandua mexicana")).toBe(false);
    expect(caps.size).toBe(1);
  });
});
