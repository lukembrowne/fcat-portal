import { describe, it, expect } from "vitest";
import { isExcludedOccupancySpecies } from "@/lib/occupancy/fetch";

// Homo sapiens (people) and Unknown (unidentified) are not wildlife and must
// never be modeled or listed as occupancy candidates. Filtered at the fetch
// source so they drop out of both the readiness report and the modeling run.
describe("isExcludedOccupancySpecies", () => {
  it("excludes Homo sapiens, Unknown, and the class-level Aves catch-all", () => {
    expect(isExcludedOccupancySpecies("Homo sapiens")).toBe(true);
    expect(isExcludedOccupancySpecies("Unknown")).toBe(true);
    expect(isExcludedOccupancySpecies("Aves")).toBe(true);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(isExcludedOccupancySpecies("  unknown ")).toBe(true);
    expect(isExcludedOccupancySpecies("HOMO SAPIENS")).toBe(true);
    expect(isExcludedOccupancySpecies("aves")).toBe(true);
  });

  it("keeps real species and other higher-taxon aggregates", () => {
    expect(isExcludedOccupancySpecies("Cuniculus paca")).toBe(false);
    expect(isExcludedOccupancySpecies("Gallus gallus domesticus")).toBe(false);
    expect(isExcludedOccupancySpecies("Rodentia")).toBe(false);
  });

  it("handles null / empty defensively", () => {
    expect(isExcludedOccupancySpecies(null)).toBe(false);
    expect(isExcludedOccupancySpecies(undefined)).toBe(false);
    expect(isExcludedOccupancySpecies("")).toBe(false);
  });
});
