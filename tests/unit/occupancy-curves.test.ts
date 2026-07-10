import { describe, it, expect } from "vitest";
import { responseCurve, habitatUse, type Effect } from "@/lib/occupancy/curves";

const effects: Effect[] = [
  { submodel: "state", param: "Int", estimate: 0 },
  { submodel: "state", param: "forest", estimate: 2 }, // positive forest response
  { submodel: "state", param: "habitatpasto", estimate: -1.5 },
  { submodel: "det", param: "Int", estimate: -0.4 },
];

describe("responseCurve", () => {
  it("is monotonic increasing for a positive coefficient", () => {
    const pts = responseCurve(effects, "forest", [0, 0.25, 0.5, 0.75, 1], 10);
    expect(pts.length).toBe(11);
    expect(pts[0].x).toBeCloseTo(0);
    expect(pts[pts.length - 1].x).toBeCloseTo(1);
    for (let i = 1; i < pts.length; i++) expect(pts[i].psi).toBeGreaterThanOrEqual(pts[i - 1].psi);
    // At the mean covariate value, ψ = plogis(intercept) = 0.5.
    const mid = pts.find((p) => Math.abs(p.x - 0.5) < 0.06);
    expect(mid!.psi).toBeCloseTo(0.5, 1);
  });

  it("returns empty when the covariate has no variation", () => {
    expect(responseCurve(effects, "forest", [0.5])).toEqual([]);
  });
});

describe("habitatUse", () => {
  it("marks the coefficient-less level as reference and applies level effects", () => {
    const bars = habitatUse(effects, ["bosque", "pasto", "bosque"]);
    expect(bars).toHaveLength(2);
    const bosque = bars.find((b) => b.habitat === "bosque")!;
    const pasto = bars.find((b) => b.habitat === "pasto")!;
    expect(bosque.isReference).toBe(true);
    expect(bosque.psi).toBeCloseTo(0.5, 5); // plogis(0)
    expect(pasto.isReference).toBe(false);
    expect(pasto.psi).toBeLessThan(bosque.psi); // negative pasto coef
  });
});
