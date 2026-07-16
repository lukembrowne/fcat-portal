import { describe, it, expect } from "vitest";
import {
  classifyModelStatus,
  buildCeilingReason,
  CEILING_NAIVE_OCCUPANCY,
  type ModelVariantRow,
} from "@/lib/occupancy/model-status";

/** A degenerate (separated) variant row, overridable per test. */
function degenerate(overrides: Partial<ModelVariantRow> = {}): ModelVariantRow {
  return {
    species: "Ramphastos ambiguus",
    stream: "audio",
    variant: "gradient",
    sufficientData: false,
    estimatedOccupancy: null,
    meanDetection: null,
    naiveOccupancy: 0.979,
    nSites: 48,
    nSitesDetected: 47,
    aic: null,
    ineligibleReasonsJson: JSON.stringify([
      "modelo no identificable: separación en el intercepto de ψ",
    ]),
    ...overrides,
  };
}

describe("classifyModelStatus", () => {
  it("returns 'modeled' with the AIC-preferred ψ/p when a variant is identifiable", () => {
    const rows: ModelVariantRow[] = [
      degenerate({ variant: "null", aic: 210, sufficientData: false }),
      {
        ...degenerate(),
        variant: "gradient",
        sufficientData: true,
        estimatedOccupancy: 0.62,
        meanDetection: 0.4,
        aic: 200,
        naiveOccupancy: 0.5,
        nSitesDetected: 24,
        ineligibleReasonsJson: null,
      },
      {
        ...degenerate(),
        variant: "habitat",
        sufficientData: true,
        estimatedOccupancy: 0.7,
        meanDetection: 0.45,
        aic: 205, // worse AIC → not preferred
        naiveOccupancy: 0.5,
        nSitesDetected: 24,
        ineligibleReasonsJson: null,
      },
    ];
    const res = classifyModelStatus(rows);
    expect(res?.kind).toBe("modeled");
    expect(res?.psi).toBe(0.62); // lowest AIC wins
    expect(res?.p).toBe(0.4);
    expect(res?.reason).toBeNull();
  });

  it("returns 'ceiling' when every fitted variant separated and naïve occupancy is high", () => {
    const rows = [
      degenerate({ variant: "gradient" }),
      degenerate({ variant: "habitat" }),
      degenerate({ variant: "null" }),
    ];
    const res = classifyModelStatus(rows);
    expect(res?.kind).toBe("ceiling");
    expect(res?.psi).toBeNull();
    expect(res?.reason).toContain("Casi ubicua");
    expect(res?.reason).toContain("47 de 48");
  });

  it("returns 'unfit' (no ubiquity wording) when all separated but naïve occupancy is low", () => {
    const rows = [
      degenerate({ variant: "gradient", naiveOccupancy: 0.5, nSitesDetected: 24 }),
      degenerate({ variant: "null", naiveOccupancy: 0.5, nSitesDetected: 24 }),
    ];
    const res = classifyModelStatus(rows);
    expect(res?.kind).toBe("unfit");
    expect(res?.reason).not.toContain("Casi ubicua");
    expect(res?.reason).toContain("separación en el intercepto");
  });

  it("treats naïve occupancy exactly at the threshold as ceiling (≥ inclusive)", () => {
    const rows = [degenerate({ naiveOccupancy: CEILING_NAIVE_OCCUPANCY, variant: "null" })];
    expect(classifyModelStatus(rows)?.kind).toBe("ceiling");
  });

  it("returns null when only the legacy ineligible 'combined' row exists", () => {
    const rows = [degenerate({ variant: "combined", naiveOccupancy: 0.1, nSitesDetected: 2 })];
    expect(classifyModelStatus(rows)).toBeNull();
  });

  it("returns null for an empty row set", () => {
    expect(classifyModelStatus([])).toBeNull();
  });

  it("falls back to a default reason when stored reasons JSON is malformed/empty", () => {
    const rows = [
      degenerate({ variant: "null", naiveOccupancy: 0.3, nSitesDetected: 10, ineligibleReasonsJson: "not json" }),
    ];
    expect(classifyModelStatus(rows)?.reason).toBe("Modelo no estimable.");
  });
});

describe("buildCeilingReason", () => {
  it("renders the site fraction and rounded percentage", () => {
    expect(buildCeilingReason(47, 48, 0.979)).toContain("47 de 48 sitios (98%)");
  });
});
