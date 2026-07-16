import { describe, it, expect } from "vitest";
import {
  HAB_ORDER,
  HABITAT,
  countSitesByHabitat,
  habitatForSite,
} from "@/app/public/biochoco-overview/lib/habitat";

describe("biochoco-overview habitat reference data", () => {
  it("HAB_ORDER lists the seven gradient habitats in the Desktop order", () => {
    expect(HAB_ORDER).toEqual([
      "primary_forest",
      "secondary_forest",
      "cacao_nacional",
      "cacao_giz",
      "cacao_ccn",
      "reforestation",
      "pasture",
    ]);
  });

  it("every ordered habitat has complete bilingual metadata", () => {
    for (const key of HAB_ORDER) {
      const meta = HABITAT[key];
      expect(meta, key).toBeDefined();
      expect(meta.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(meta.name.en.length).toBeGreaterThan(0);
      expect(meta.name.es.length).toBeGreaterThan(0);
      expect(meta.description.en.length).toBeGreaterThan(0);
      expect(meta.description.es.length).toBeGreaterThan(0);
    }
  });

  it("colors match the Desktop HAB constant exactly", () => {
    expect(HABITAT.primary_forest.color).toBe("#1b7a3d");
    expect(HABITAT.cacao_ccn.color).toBe("#CD853F");
    expect(HABITAT.pasture.color).toBe("#FDD835");
  });

  it("resolves known site codes and falls back to unknown", () => {
    expect(habitatForSite("PRI-001")).toBe("primary_forest");
    expect(habitatForSite("CCN-001")).toBe("cacao_ccn");
    expect(habitatForSite("POT-002")).toBe("pasture");
    expect(habitatForSite("ZZZ-999")).toBe("unknown");
  });

  describe("countSitesByHabitat", () => {
    it("counts distinct sites per habitat, summing to the distinct-site total", () => {
      const codes = ["PRI-001", "PRI-004", "CCN-001", "POT-002"];
      const counts = countSitesByHabitat(codes);
      expect(counts).toEqual({ primary_forest: 2, cacao_ccn: 1, pasture: 1 });
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      expect(total).toBe(new Set(codes).size);
    });

    it("de-duplicates repeated codes (two deployments, one site)", () => {
      expect(countSitesByHabitat(["PRI-001", "PRI-001"])).toEqual({ primary_forest: 1 });
    });

    it("buckets unmapped codes under unknown without crashing", () => {
      expect(countSitesByHabitat(["ZZZ-999", "PRI-001"])).toEqual({
        unknown: 1,
        primary_forest: 1,
      });
    });

    it("returns an empty object for no sites", () => {
      expect(countSitesByHabitat([])).toEqual({});
    });
  });
});
