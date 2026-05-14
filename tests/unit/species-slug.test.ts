import { describe, expect, it } from "vitest";
import { speciesSlug } from "@/lib/species-slug";

describe("speciesSlug", () => {
  it("lowercases and hyphenates a binomial name", () => {
    expect(speciesSlug("Ramphastos ambiguus")).toBe("ramphastos-ambiguus");
    expect(speciesSlug("Cebus albifrons")).toBe("cebus-albifrons");
  });

  it("strips diacritics", () => {
    expect(speciesSlug("Cebus aequatorialis")).toBe("cebus-aequatorialis");
    expect(speciesSlug("Tinamús major")).toBe("tinamus-major");
    expect(speciesSlug("Crax rúbra")).toBe("crax-rubra");
  });

  it("collapses non-alphanumeric runs into single hyphens", () => {
    expect(speciesSlug("Genus  species  subsp.")).toBe("genus-species-subsp");
    expect(speciesSlug("A/B C-D")).toBe("a-b-c-d");
  });

  it("trims leading and trailing hyphens", () => {
    expect(speciesSlug(" Ramphastos ambiguus ")).toBe("ramphastos-ambiguus");
    expect(speciesSlug("--Crax--")).toBe("crax");
  });

  it("handles single-word names", () => {
    expect(speciesSlug("Trogon")).toBe("trogon");
    expect(speciesSlug("ñandú")).toBe("nandu");
  });

  it("returns empty string for input with no alphanumerics", () => {
    expect(speciesSlug("---")).toBe("");
    expect(speciesSlug("")).toBe("");
  });
});
