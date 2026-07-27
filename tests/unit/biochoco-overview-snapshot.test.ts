import { describe, it, expect } from "vitest";
import {
  exactCoord,
  isRealSpecies,
  siteCode,
  stripSpectrograms,
  summarizeCameraSpecies,
  type EffectiveSpeciesRow,
  type SpeciesMeta,
} from "@/app/public/biochoco-overview/lib/snapshot-transforms";
import type { ReportSnapshot } from "@/app/public/biochoco-overview/lib/snapshot-types";

describe("siteCode (privacy: landowner names never leak)", () => {
  it("strips the landowner suffix to the site code", () => {
    expect(siteCode("CCN-001_Don Adrian")).toBe("CCN-001");
    expect(siteCode("NAC-005_Finca La Esperanza")).toBe("NAC-005");
  });

  it("returns the whole name when there is no underscore", () => {
    expect(siteCode("PRI-007")).toBe("PRI-007");
  });
});

describe("exactCoord (sampling sites shown at full precision)", () => {
  it("passes finite coordinates through unchanged", () => {
    expect(exactCoord(0.123456)).toBe(0.123456);
    expect(exactCoord(-79.98765)).toBe(-79.98765);
  });

  it("passes null / NaN through as null", () => {
    expect(exactCoord(null)).toBeNull();
    expect(exactCoord(Number.NaN)).toBeNull();
  });
});

describe("isRealSpecies", () => {
  const species = (over: Partial<SpeciesMeta>): SpeciesMeta => ({
    type: "mammal",
    taxonomicRank: "species",
    commonName: "x",
    spanishName: null,
    ...over,
  });

  it("keeps non-system species-rank rows", () => {
    expect(isRealSpecies(species({}))).toBe(true);
    expect(isRealSpecies(species({ taxonomicRank: null }))).toBe(true);
  });

  it("drops system rows (Unknown / Homo sapiens)", () => {
    expect(isRealSpecies(species({ type: "system" }))).toBe(false);
  });

  it("drops higher taxa (class / order / genus)", () => {
    expect(isRealSpecies(species({ taxonomicRank: "class" }))).toBe(false);
    expect(isRealSpecies(species({ taxonomicRank: "order" }))).toBe(false);
    expect(isRealSpecies(species({ taxonomicRank: "genus" }))).toBe(false);
  });

  it("drops labels with no metadata", () => {
    expect(isRealSpecies(undefined)).toBe(false);
  });
});

describe("summarizeCameraSpecies", () => {
  const meta = new Map<string, SpeciesMeta>([
    ["Panthera onca", { type: "mammal", taxonomicRank: "species", commonName: "Jaguar", spanishName: "Jaguar" }],
    ["Tinamus major", { type: "bird", taxonomicRank: "species", commonName: "Tinamou", spanishName: "Tinamú" }],
    ["Aves", { type: "system", taxonomicRank: "class", commonName: "Birds", spanishName: null }],
    ["Rodentia", { type: "mammal", taxonomicRank: "order", commonName: "Rodents", spanishName: null }],
    ["Leptotila sp.", { type: "bird", taxonomicRank: "genus", commonName: "Dove", spanishName: null }],
    ["Homo sapiens", { type: "system", taxonomicRank: "species", commonName: "Human", spanishName: null }],
  ]);

  const effRows: EffectiveSpeciesRow[] = [
    { eff: "Panthera onca", detections: 40 },
    { eff: "Aves", detections: 30 },
    { eff: "Tinamus major", detections: 20 },
    { eff: "Rodentia", detections: 15 },
    { eff: "Leptotila sp.", detections: 10 },
    { eff: "Homo sapiens", detections: 5 },
    { eff: "Unknown label with no meta", detections: 2 },
  ];

  it("counts only real species and breaks down by type", () => {
    const out = summarizeCameraSpecies(effRows, meta);
    expect(out.cameraRealSpecies).toBe(2); // jaguar + tinamou
    expect(out.cameraSpeciesByType).toEqual({ mammal: 1, bird: 1 });
  });

  it("returns top species ordered by detections, carrying names", () => {
    const out = summarizeCameraSpecies(effRows, meta);
    expect(out.cameraTopSpecies.map((s) => s.sci)).toEqual(["Panthera onca", "Tinamus major"]);
    expect(out.cameraTopSpecies[0]).toMatchObject({ commonName: "Jaguar", spanishName: "Jaguar", type: "mammal" });
  });

  it("respects the topN cap", () => {
    const out = summarizeCameraSpecies(effRows, meta, 1);
    expect(out.cameraTopSpecies).toHaveLength(1);
    expect(out.cameraTopSpecies[0].sci).toBe("Panthera onca");
  });
});

describe("stripSpectrograms (page payload never carries inlined images)", () => {
  const snapshot = (audio: ReportSnapshot["audio"]): ReportSnapshot =>
    ({
      slug: "biochoco-overview",
      generatedAt: "2026-07-27T00:00:00.000Z",
      generatedBy: null,
      stats: {} as ReportSnapshot["stats"],
      images: [],
      audio,
    }) as ReportSnapshot;

  it("replaces each data URI with a boolean flag", () => {
    const out = stripSpectrograms(
      snapshot([
        {
          audioId: 1,
          speciesLabel: "Ramphastos brevis",
          caption: { en: "a", es: "a" },
          spectrogramPng: "data:image/webp;base64,AAAA",
        },
      ]),
    );

    expect(out.audio[0].spectrogramPng).toBeUndefined();
    expect(out.audio[0].hasSpectrogram).toBe(true);
    // The guard that matters: no base64 survives anywhere in the serialized
    // payload React ships to the browser.
    expect(JSON.stringify(out)).not.toContain("base64");
  });

  it("flags clips with no pre-rendered image so the page falls back to client FFT", () => {
    const out = stripSpectrograms(
      snapshot([
        { audioId: 2, speciesLabel: "Ortalis erythroptera", caption: { en: "b", es: "b" } },
      ]),
    );

    expect(out.audio[0].hasSpectrogram).toBe(false);
  });

  it("leaves the rest of the snapshot untouched", () => {
    const input = snapshot([
      {
        audioId: 3,
        speciesLabel: "Pulsatrix perspicillata",
        caption: { en: "c", es: "c" },
        spectrogramPng: "data:image/webp;base64,BBBB",
      },
    ]);
    const out = stripSpectrograms(input);

    expect(out.slug).toBe(input.slug);
    expect(out.generatedAt).toBe(input.generatedAt);
    expect(out.audio[0].audioId).toBe(3);
    expect(out.audio[0].speciesLabel).toBe("Pulsatrix perspicillata");
    expect(out.audio[0].caption).toEqual({ en: "c", es: "c" });
    // Non-mutating — the stored snapshot the media routes read must keep its image.
    expect(input.audio[0].spectrogramPng).toBe("data:image/webp;base64,BBBB");
  });
});
