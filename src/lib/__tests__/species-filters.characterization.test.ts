/**
 * Characterization of the wild-species filter as it behaved BEFORE the rule was
 * extracted into `src/lib/species-filters.ts`.
 *
 * The rule lived in three places at once: `isRealSpecies` in the public
 * overview's snapshot transforms, and two byte-identical copies of a `DOMESTIC`
 * set in `download/route.ts` and `report-shell.tsx`. This file pins the composed
 * behaviour — real-species predicate, then domestic exclusion, then the top-9
 * slice the public page renders — with the expected values written out as
 * literals rather than recomputed from the implementation.
 *
 * It exists so the extraction is provably behaviour-preserving. If a future
 * change to the shared module alters what the public BioChoco overview lists,
 * this fails and names it.
 */

import { describe, it, expect } from "vitest";

import { summarizeCameraSpecies } from "@/app/public/biochoco-overview/lib/snapshot-transforms";
import type {
  SpeciesMeta,
  EffectiveSpeciesRow,
} from "@/app/public/biochoco-overview/lib/snapshot-transforms";
import { DOMESTIC, isRealSpecies, isWildSpecies } from "../species-filters";

/**
 * The domestic list exactly as both public-overview files carried it before the
 * extraction. Written out here rather than imported so this test would catch a
 * silent edit to the shared set.
 */
const DOMESTIC_AS_SHIPPED = [
  "Gallus gallus domesticus",
  "Canis lupus familiaris",
  "Bos taurus",
  "Anas platyrhynchos domesticus",
  "Equus caballus",
  "Felis catus",
  "Sus scrofa domesticus",
];

const meta = (
  over: Partial<SpeciesMeta> = {},
): SpeciesMeta => ({
  type: "mammal",
  taxonomicRank: "species",
  commonName: "Common",
  spanishName: "Común",
  ...over,
});

/** A realistic mix: wild mammals and birds, bucket classes, and domestics. */
const FIXTURE: Array<[string, SpeciesMeta, number]> = [
  ["Dasyprocta punctata", meta({ commonName: "Central American agouti" }), 246],
  ["Dicotyles tajacu", meta({ commonName: "Collared peccary" }), 112],
  ["Canis lupus familiaris", meta({ commonName: "Dog" }), 95],
  ["Dasypus fenestratus", meta({ commonName: "Armadillo" }), 57],
  ["Aves", meta({ taxonomicRank: "class", commonName: "Birds" }), 51],
  ["Nasua narica", meta({ commonName: "Coati" }), 38],
  ["Unknown", meta({ type: "system", commonName: "Unknown" }), 33],
  ["Cuniculus paca", meta({ commonName: "Paca" }), 29],
  ["Equus caballus", meta({ commonName: "Horse" }), 24],
  ["Eira barbara", meta({ commonName: "Tayra" }), 21],
  ["Rodentia", meta({ taxonomicRank: "order", commonName: "Rodents" }), 19],
  ["Leopardus pardalis", meta({ commonName: "Ocelot" }), 18],
  ["Didelphis marsupialis", meta({ commonName: "Common opossum" }), 10],
  ["Proechimys semispinosus", meta({ commonName: "Spiny rat" }), 8],
  ["Penelope purpurascens", meta({ type: "bird", commonName: "Crested guan" }), 6],
  ["Leptotila sp.", meta({ type: "bird", taxonomicRank: "genus", commonName: "Dove" }), 5],
  ["Tamandua mexicana", meta({ commonName: "Tamandua" }), 3],
];

const effRows: EffectiveSpeciesRow[] = FIXTURE.map(([eff, , detections]) => ({
  eff,
  detections,
}));
const speciesMeta = new Map(FIXTURE.map(([sci, m]) => [sci, m]));

describe("characterization: the public overview's wild camera species", () => {
  it("produces exactly the list the page rendered before the extraction", () => {
    const { cameraTopSpecies } = summarizeCameraSpecies(effRows, speciesMeta, 20);
    const domestic = new Set(DOMESTIC_AS_SHIPPED);
    const camWild = cameraTopSpecies
      .filter((sp) => !domestic.has(sp.sci))
      .slice(0, 9);

    expect(camWild.map((sp) => sp.sci)).toEqual([
      "Dasyprocta punctata",
      "Dicotyles tajacu",
      "Dasypus fenestratus",
      "Nasua narica",
      "Cuniculus paca",
      "Eira barbara",
      "Leopardus pardalis",
      "Didelphis marsupialis",
      "Proechimys semispinosus",
    ]);
  });

  it("counts real species without the bucket classes or the system entries", () => {
    const { cameraRealSpecies } = summarizeCameraSpecies(effRows, speciesMeta, 20);
    // 17 fixture rows minus Aves (class), Rodentia (order), Leptotila sp.
    // (genus) and Unknown (system). Domestics still count here — the domestic
    // filter was applied later, at render time, not in the summary.
    expect(cameraRealSpecies).toBe(13);
  });

  it("keeps detection order and per-species counts intact", () => {
    const { cameraTopSpecies } = summarizeCameraSpecies(effRows, speciesMeta, 20);
    expect(cameraTopSpecies[0]).toMatchObject({
      sci: "Dasyprocta punctata",
      detections: 246,
    });
  });
});

describe("the extracted module reproduces the original predicates", () => {
  it("carries the same domestic set, unchanged", () => {
    expect([...DOMESTIC].sort()).toEqual([...DOMESTIC_AS_SHIPPED].sort());
  });

  it("agrees with isRealSpecies on every fixture row", () => {
    for (const [sci, m] of FIXTURE.map(([s, mm]) => [s, mm] as const)) {
      const expected = m.type !== "system" && (!m.taxonomicRank || m.taxonomicRank === "species");
      expect(isRealSpecies(m), sci).toBe(expected);
    }
  });

  it("composes both rules: isWildSpecies excludes buckets and domestics alike", () => {
    const wild = FIXTURE.filter(([sci, m]) => isWildSpecies(m, sci)).map(([sci]) => sci);

    expect(wild).toEqual([
      "Dasyprocta punctata",
      "Dicotyles tajacu",
      "Dasypus fenestratus",
      "Nasua narica",
      "Cuniculus paca",
      "Eira barbara",
      "Leopardus pardalis",
      "Didelphis marsupialis",
      "Proechimys semispinosus",
      "Penelope purpurascens",
      "Tamandua mexicana",
    ]);
  });
});
