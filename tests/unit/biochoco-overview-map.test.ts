import { describe, it, expect } from "vitest";
import { markerColor, legendRows } from "@/app/public/biochoco-overview/lib/map-helpers";
import { HABITAT } from "@/app/public/biochoco-overview/lib/habitat";

describe("overview map helpers", () => {
  describe("markerColor", () => {
    it("resolves a known habitat to its color", () => {
      expect(markerColor("primary_forest")).toBe(HABITAT.primary_forest.color);
      expect(markerColor("pasture")).toBe(HABITAT.pasture.color);
    });

    it("falls back to the unknown color for an unmapped habitat", () => {
      expect(markerColor("unknown")).toBe(HABITAT.unknown.color);
      expect(markerColor("not_a_habitat")).toBe(HABITAT.unknown.color);
    });
  });

  describe("legendRows", () => {
    it("returns only habitats with a positive count, in gradient order", () => {
      const counts = { pasture: 3, primary_forest: 5, cacao_giz: 0 };
      expect(legendRows(counts)).toEqual(["primary_forest", "pasture"]);
    });

    it("omits zero and missing habitats", () => {
      expect(legendRows({})).toEqual([]);
      expect(legendRows({ reforestation: 0 })).toEqual([]);
    });
  });
});
