/**
 * U3 — BirdNET name-reference parsing (app-side helper).
 */

import fs from "node:fs";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  __resetBirdnetNameCache,
  canonicalBirdnetName,
  parseCsvLine,
  parseReferenceCsv,
} from "@/lib/birdnet-taxonomy";

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

describe("canonicalBirdnetName", () => {
  const header = "scientific_name,common_name,spanish_name\n";

  function serve(csv: string) {
    vi.spyOn(fs, "readFileSync").mockReturnValue(csv as never);
    __resetBirdnetNameCache();
  }

  afterEach(() => {
    vi.restoreAllMocks();
    __resetBirdnetNameCache();
  });

  it("returns an exact label unchanged", () => {
    serve(header + "Zonotrichia albicollis,White-throated Sparrow,\n");
    expect(canonicalBirdnetName("Zonotrichia albicollis")).toBe("Zonotrichia albicollis");
  });

  it("canonicalises case and whitespace but never guesses", () => {
    serve(header + "Zonotrichia albicollis,White-throated Sparrow,\n");
    expect(canonicalBirdnetName("  zonotrichia   ALBICOLLIS ")).toBe(
      "Zonotrichia albicollis"
    );
    expect(canonicalBirdnetName("Zonotrichia albicolis")).toBeNull();
    expect(canonicalBirdnetName("   ")).toBeNull();
  });

  it("one reset clears the case-insensitive index along with the name map", () => {
    serve(header + "Zonotrichia albicollis,White-throated Sparrow,\n");
    expect(canonicalBirdnetName("zonotrichia albicollis")).toBe("Zonotrichia albicollis");

    // A different label list after the reset: the stale lower-case index must
    // not keep answering for a label the new list does not carry.
    serve(header + "Turdus fuscater,Great Thrush,\n");
    expect(canonicalBirdnetName("zonotrichia albicollis")).toBeNull();
    expect(canonicalBirdnetName("turdus FUSCATER")).toBe("Turdus fuscater");
  });
});
