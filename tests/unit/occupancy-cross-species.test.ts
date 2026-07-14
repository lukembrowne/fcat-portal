import { describe, it, expect } from "vitest";
import { toForestPlot, inverseVarianceMean, preferredByAic } from "@/lib/occupancy/meta-analysis";
import { sumRichness } from "@/lib/occupancy/richness";

describe("preferredByAic", () => {
  it("picks the lowest-AIC variant", () => {
    const geo = { variant: "geo", aic: 201.6 };
    const habitat = { variant: "habitat", aic: 188.2 };
    expect(preferredByAic([geo, habitat])).toBe(habitat);
    expect(preferredByAic([habitat, geo])).toBe(habitat); // order-independent
  });

  it("treats a null AIC as worst (a fitted variant beats an unscored one)", () => {
    const geo = { variant: "geo", aic: 201.6 };
    const habitat = { variant: "habitat", aic: null };
    expect(preferredByAic([habitat, geo])).toBe(geo);
  });

  it("returns the first when every AIC is null, and null for an empty set", () => {
    const a = { variant: "geo", aic: null };
    const b = { variant: "habitat", aic: null };
    expect(preferredByAic([a, b])).toBe(a);
    expect(preferredByAic([])).toBeNull();
  });
});

describe("toForestPlot", () => {
  it("adds 95% CIs and sorts by effect size descending", () => {
    const rows = toForestPlot([
      { species: "A", stream: "camera", estimate: 0.5, se: 0.1 },
      { species: "B", stream: "camera", estimate: 2.0, se: 0.5 },
      { species: "C", stream: "audio", estimate: 1.0, se: null },
    ]);
    // sorted by estimate desc: B(2.0), C(1.0), A(0.5)
    expect(rows.map((r) => r.species)).toEqual(["B", "C", "A"]);
    expect(rows[0].lower).toBeCloseTo(2.0 - 1.959964 * 0.5, 4); // B
    expect(rows[1].lower).toBeNull(); // C has no SE
    expect(rows[2].lower).toBeCloseTo(0.5 - 1.959964 * 0.1, 4); // A
  });
});

describe("inverseVarianceMean", () => {
  it("weights by inverse variance and ignores rows without SE", () => {
    const m = inverseVarianceMean([
      { species: "A", stream: "camera", estimate: 1.0, se: 0.1 }, // high weight
      { species: "B", stream: "camera", estimate: 3.0, se: 1.0 }, // low weight
      { species: "C", stream: "camera", estimate: 99, se: null }, // ignored
    ]);
    // dominated by A → close to 1.0
    expect(m).toBeGreaterThan(1.0);
    expect(m).toBeLessThan(1.1);
  });

  it("returns null when no usable SEs", () => {
    expect(inverseVarianceMean([{ species: "A", stream: "camera", estimate: 1, se: null }])).toBeNull();
  });
});

describe("sumRichness", () => {
  it("sums psi across aligned grids and counts contributing species", () => {
    const g1 = [{ lat: 0.4, lng: -79.6, psi: 0.3 }, { lat: 0.41, lng: -79.6, psi: 0.5 }];
    const g2 = [{ lat: 0.4, lng: -79.6, psi: 0.4 }, { lat: 0.41, lng: -79.6, psi: null }];
    const rich = sumRichness([g1, g2]);
    const cellA = rich.find((c) => c.lat === 0.4)!;
    expect(cellA.richness).toBeCloseTo(0.7, 6);
    expect(cellA.nSpecies).toBe(2);
    const cellB = rich.find((c) => c.lat === 0.41)!;
    expect(cellB.richness).toBeCloseTo(0.5, 6); // null skipped
    expect(cellB.nSpecies).toBe(1);
  });
});
