/**
 * U3 — BirdNET name-reference parsing (app-side helper).
 */

import { describe, it, expect } from "vitest";
import { parseCsvLine, parseReferenceCsv } from "@/lib/birdnet-taxonomy";

describe("parseCsvLine", () => {
  it("splits simple comma fields", () => {
    expect(parseCsvLine("Panthera onca,Jaguar,Jaguar")).toEqual([
      "Panthera onca",
      "Jaguar",
      "Jaguar",
    ]);
  });

  it("honors quoted fields containing commas", () => {
    expect(parseCsvLine('X y,"Foo, bar",Baz')).toEqual(["X y", "Foo, bar", "Baz"]);
  });

  it("handles escaped double-quotes inside a quoted field", () => {
    expect(parseCsvLine('a,"He said ""hi""",c')).toEqual(["a", 'He said "hi"', "c"]);
  });
});

describe("parseReferenceCsv", () => {
  const csv =
    "scientific_name,common_name,spanish_name\n" +
    "Adelomyia melanogenys,Speckled Hummingbird,Colibrí Jaspeado\n" +
    "Amazilia tzacatl,Rufous-tailed Hummingbird,\n";

  it("maps scientific name to common + spanish names, skipping the header", () => {
    const map = parseReferenceCsv(csv);
    expect(map.get("Adelomyia melanogenys")).toEqual({
      commonName: "Speckled Hummingbird",
      spanishName: "Colibrí Jaspeado",
    });
  });

  it("nulls an empty spanish field", () => {
    const map = parseReferenceCsv(csv);
    expect(map.get("Amazilia tzacatl")?.spanishName).toBeNull();
  });

  it("ignores blank trailing lines", () => {
    const map = parseReferenceCsv(csv + "\n\n");
    expect(map.size).toBe(2);
  });
});
