/**
 * U1 — BirdNET label extraction (pure pairing logic).
 */

import { describe, it, expect } from "vitest";
import {
  parseLabelFile,
  pairLocales,
  toCsv,
} from "../../scripts/extract-birdnet-labels.mjs";

describe("parseLabelFile", () => {
  it("splits `Genus species_Common Name` on the first underscore", () => {
    const rows = parseLabelFile("Adelomyia melanogenys_Speckled Hummingbird\n");
    expect(rows).toEqual([
      { scientificName: "Adelomyia melanogenys", commonName: "Speckled Hummingbird" },
    ]);
  });

  it("keeps common names that contain spaces and hyphens", () => {
    const rows = parseLabelFile("Amazilia tzacatl_Rufous-tailed Hummingbird\n");
    expect(rows[0].commonName).toBe("Rufous-tailed Hummingbird");
  });

  it("skips blank and malformed (no underscore) lines", () => {
    const rows = parseLabelFile("\nPanthera onca_Jaguar\nnodelimiter\n   \n");
    expect(rows).toHaveLength(1);
    expect(rows[0].scientificName).toBe("Panthera onca");
  });
});

describe("pairLocales", () => {
  const en = "Adelomyia melanogenys_Speckled Hummingbird\nAmazilia tzacatl_Rufous-tailed Hummingbird\n";
  const es = "Adelomyia melanogenys_Colibrí Jaspeado\n";

  it("pairs English + Spanish by scientific name", () => {
    const rows = pairLocales(en, es);
    const adel = rows.find((r) => r.scientificName === "Adelomyia melanogenys");
    expect(adel).toEqual({
      scientificName: "Adelomyia melanogenys",
      commonName: "Speckled Hummingbird",
      spanishName: "Colibrí Jaspeado",
    });
  });

  it("leaves spanishName blank when the species is missing from the es file", () => {
    const rows = pairLocales(en, es);
    const amaz = rows.find((r) => r.scientificName === "Amazilia tzacatl");
    expect(amaz?.spanishName).toBe("");
  });

  it("uses English as the authoritative row set (order + membership)", () => {
    const rows = pairLocales(en, es);
    expect(rows.map((r) => r.scientificName)).toEqual([
      "Adelomyia melanogenys",
      "Amazilia tzacatl",
    ]);
  });

  it("pairs by name even when locales are in different order", () => {
    const enUnordered = "B sp_Beta\nA sp_Alpha\n";
    const esUnordered = "A sp_AlphaES\nB sp_BetaES\n";
    const rows = pairLocales(enUnordered, esUnordered);
    expect(rows).toEqual([
      { scientificName: "B sp", commonName: "Beta", spanishName: "BetaES" },
      { scientificName: "A sp", commonName: "Alpha", spanishName: "AlphaES" },
    ]);
  });
});

describe("toCsv", () => {
  it("emits a header + CSV-escaped rows", () => {
    const csv = toCsv([
      { scientificName: "Panthera onca", commonName: "Jaguar", spanishName: "Jaguar" },
    ]);
    expect(csv.split("\n")[0]).toBe("scientific_name,common_name,spanish_name");
    expect(csv).toContain("Panthera onca,Jaguar,Jaguar");
  });

  it("quotes fields containing commas", () => {
    const csv = toCsv([
      { scientificName: "X y", commonName: "Foo, bar", spanishName: "" },
    ]);
    expect(csv).toContain('"Foo, bar"');
  });
});
