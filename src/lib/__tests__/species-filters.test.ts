import { describe, it, expect } from "vitest";

import {
  DOMESTIC,
  isDomestic,
  isHumanLabel,
  isRealSpecies,
  isWildSpecies,
  type SpeciesTypeMeta,
} from "../species-filters";

const speciesRank = (type = "mammal"): SpeciesTypeMeta => ({
  type,
  taxonomicRank: "species",
});

describe("isRealSpecies", () => {
  it("accepts a species-rank mammal", () => {
    expect(isRealSpecies(speciesRank())).toBe(true);
  });

  it("accepts a species-rank bird", () => {
    expect(isRealSpecies(speciesRank("bird"))).toBe(true);
  });

  it("rejects the same metadata once its type is system", () => {
    expect(isRealSpecies({ type: "system", taxonomicRank: "species" })).toBe(false);
  });

  it("rejects the bucket classes by rank", () => {
    expect(isRealSpecies({ type: "bird", taxonomicRank: "class" })).toBe(false); // Aves
    expect(isRealSpecies({ type: "mammal", taxonomicRank: "order" })).toBe(false); // Rodentia
    expect(isRealSpecies({ type: "bird", taxonomicRank: "genus" })).toBe(false); // Leptotila sp.
    expect(isRealSpecies({ type: "mammal", taxonomicRank: "family" })).toBe(false);
  });

  it("treats a null rank as species, matching the lookup's older rows", () => {
    expect(isRealSpecies({ type: "mammal", taxonomicRank: null })).toBe(true);
  });

  it("rejects undefined metadata rather than throwing", () => {
    expect(() => isRealSpecies(undefined)).not.toThrow();
    expect(isRealSpecies(undefined)).toBe(false);
  });
});

describe("isDomestic", () => {
  it("rejects every name in the domestic set", () => {
    for (const name of DOMESTIC) {
      expect(isDomestic(name), name).toBe(true);
    }
  });

  it("holds exactly the seven names the public surfaces shipped", () => {
    expect(DOMESTIC.size).toBe(7);
  });

  it("does not match a wild congener of a domestic animal", () => {
    // Sus scrofa (wild boar) is not Sus scrofa domesticus.
    expect(isDomestic("Sus scrofa")).toBe(false);
    expect(isDomestic("Canis lupus")).toBe(false);
  });

  it("is exact, not prefix or case insensitive", () => {
    expect(isDomestic("equus caballus")).toBe(false);
    expect(isDomestic("Equus")).toBe(false);
    expect(isDomestic("")).toBe(false);
  });
});

describe("isWildSpecies", () => {
  it("accepts a wild species-rank animal", () => {
    expect(isWildSpecies(speciesRank(), "Leopardus pardalis")).toBe(true);
  });

  it("rejects each domestic animal even though its metadata is species-rank", () => {
    // This is the case isRealSpecies alone gets wrong: a horse is a real
    // species-rank mammal, and AE2 turns on it being excluded from P10.
    for (const name of DOMESTIC) {
      expect(isWildSpecies(speciesRank(), name), name).toBe(false);
    }
  });

  it("rejects a bucket class regardless of name", () => {
    expect(isWildSpecies({ type: "bird", taxonomicRank: "class" }, "Aves")).toBe(false);
    expect(isWildSpecies({ type: "mammal", taxonomicRank: "order" }, "Rodentia")).toBe(false);
  });

  it("rejects a name absent from the species lookup rather than throwing", () => {
    // An unrecognised label reaches here with undefined metadata. It must never
    // be reported as a wild species just because it is not on the domestic list.
    expect(() => isWildSpecies(undefined, "Genus novum")).not.toThrow();
    expect(isWildSpecies(undefined, "Genus novum")).toBe(false);
  });

  it("rejects the system Unknown entry", () => {
    expect(isWildSpecies({ type: "system", taxonomicRank: null }, "Unknown")).toBe(false);
  });
});

describe("DOMESTIC as a shared constant", () => {
  it("is exposed read-only so a consumer cannot mutate the shared set", () => {
    // Typed ReadonlySet; this guards the runtime shape the two public surfaces
    // and the export now share.
    const asMutable = DOMESTIC as Set<string>;
    const before = asMutable.size;
    expect(before).toBe(7);
    expect(DOMESTIC.has("Felis catus")).toBe(true);
  });
});

describe("isHumanLabel", () => {
  it("catches the portal's own label", () => {
    expect(isHumanLabel("Homo sapiens")).toBe(true);
  });

  it("catches it however it was typed or stored", () => {
    for (const label of [
      "homo sapiens",
      "HOMO SAPIENS",
      "  Homo   sapiens  ",
      "homo_sapiens", // the exporter's folder-name form
      "Homo sapiens (Human)",
    ]) {
      expect(isHumanLabel(label), label).toBe(true);
    }
  });

  it("catches every binomial under the genus, and the bare genus", () => {
    expect(isHumanLabel("Homo")).toBe(true);
    expect(isHumanLabel("Homo sapiens sapiens")).toBe(true);
    expect(isHumanLabel("Homo neanderthalensis")).toBe(true);
  });

  it("catches the vocabularies an imported corpus would bring", () => {
    // MegaDetector / COCO-Camera-Traps call the class `person`; LILA metadata
    // uses common names. None of these exist in biochoco_species, so the
    // lookup-based rules would never see them.
    for (const label of ["person", "Person", "human", "Humans", "people"]) {
      expect(isHumanLabel(label), label).toBe(true);
    }
  });

  it("catches the Spanish forms the UI uses", () => {
    for (const label of ["Humano", "humanos", "Persona", "personas", "gente"]) {
      expect(isHumanLabel(label), label).toBe(true);
    }
  });

  it("does not catch a real taxon that merely starts with the same letters", () => {
    // The prefix rule requires a word boundary precisely so these survive.
    expect(isHumanLabel("Homoptera")).toBe(false);
    expect(isHumanLabel("Pachyramphus homochrous")).toBe(false);
    expect(isHumanLabel("Homalopsis")).toBe(false);
  });

  it("does not catch the other system labels", () => {
    // Unknown and Blank are excluded from the training export by the class
    // thresholds, not by this rule — it answers one question only.
    expect(isHumanLabel("Unknown")).toBe(false);
    expect(isHumanLabel("Blank")).toBe(false);
  });

  it("treats an empty or whitespace label as not human", () => {
    expect(isHumanLabel("")).toBe(false);
    expect(isHumanLabel("   ")).toBe(false);
  });

  it("keeps every wild species in the fixture set", () => {
    for (const label of [
      "Leopardus pardalis",
      "Cuniculus paca",
      "Proechimys semispinosus",
      "Dasypus fenestratus",
      "Aramides wolfi",
      "Leptotila sp.",
      "Aves",
      "Rodentia",
    ]) {
      expect(isHumanLabel(label), label).toBe(false);
    }
  });

  it("keeps the domestic animals — they are excluded by a different rule", () => {
    for (const label of DOMESTIC) {
      expect(isHumanLabel(label), label).toBe(false);
    }
  });
});
