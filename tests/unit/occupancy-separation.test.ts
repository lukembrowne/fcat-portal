import { describe, it, expect } from "vitest";
import { isSeparated, classifyModelIdentifiability } from "@/lib/occupancy/separation";

describe("isSeparated", () => {
  it("flags blown-up estimates and non-finite SEs", () => {
    expect(isSeparated(20, 800)).toBe(true); // ±∞ coefficient, huge SE
    expect(isSeparated(-18, 0.5)).toBe(true); // |estimate| past bound
    expect(isSeparated(1.2, NaN)).toBe(true); // NaN SE = not identifiable
    expect(isSeparated(null, 1)).toBe(true);
    expect(isSeparated(1, null)).toBe(true);
  });

  it("passes real, estimable coefficients", () => {
    expect(isSeparated(0.93, 1.08)).toBe(false); // paca intercept
    expect(isSeparated(-0.68, 0.82)).toBe(false); // paca forest slope
  });
});

describe("classifyModelIdentifiability", () => {
  it("marks a fully-separated model non-identifiable (ocelot case)", () => {
    // Every ψ term ran off to ±∞ with NaN/huge SE.
    const res = classifyModelIdentifiability([
      { name: "Int", estimate: 22, se: NaN },
      { name: "forest", estimate: -20, se: 900 },
      { name: "elevation", estimate: 19, se: 1200 },
    ]);
    expect(res.identifiable).toBe(false);
    expect(res.reason).toMatch(/no identificable/);
  });

  it("marks non-identifiable when the intercept alone separated", () => {
    const res = classifyModelIdentifiability([
      { name: "Int", estimate: 30, se: NaN },
      { name: "forest", estimate: 0.4, se: 0.6 }, // a finite slope can't rescue a broken baseline
    ]);
    expect(res.identifiable).toBe(false);
    expect(res.reason).toMatch(/intercepto/);
  });

  it("keeps a model with a clean intercept and ≥1 estimable slope (paca case)", () => {
    const res = classifyModelIdentifiability([
      { name: "Int", estimate: 0.93, se: 1.08 },
      { name: "forest", estimate: -0.68, se: 0.82 },
      { name: "elevation", estimate: 0.55, se: 0.69 },
      { name: "habitatCacao CCN", estimate: -2.96, se: 2.27 }, // one noisy level, not separated
      { name: "habitatCacao GIZ", estimate: 20, se: 800 }, // this level separated — but model survives
    ]);
    expect(res.identifiable).toBe(true);
    expect(res.reason).toBeUndefined();
  });

  it("keeps an estimable intercept-only (ψ~1) model", () => {
    const res = classifyModelIdentifiability([{ name: "Int", estimate: -0.4, se: 0.3 }]);
    expect(res.identifiable).toBe(true);
  });

  it("marks non-identifiable when every slope separated even with a clean intercept", () => {
    const res = classifyModelIdentifiability([
      { name: "Int", estimate: 0.5, se: 0.9 },
      { name: "forest", estimate: 22, se: NaN },
      { name: "elevation", estimate: -19, se: 1100 },
    ]);
    expect(res.identifiable).toBe(false);
    expect(res.reason).toMatch(/todos los términos/);
  });

  it("defensively rejects an empty coefficient set", () => {
    const res = classifyModelIdentifiability([]);
    expect(res.identifiable).toBe(false);
    expect(res.reason).toMatch(/sin coeficientes/);
  });
});
