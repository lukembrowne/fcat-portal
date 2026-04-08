import { describe, it, expect } from "vitest";
import {
  displaySpecies,
  LOW_CONFIDENCE_LABEL,
  type ModelForDisplay,
} from "@/lib/display-species";

const modelById = new Map<number, ModelForDisplay>([
  [1, { confidenceThreshold: 0.55 }],
  [2, { confidenceThreshold: 0.9 }],
]);

describe("displaySpecies", () => {
  it("returns raw species for legacy AI4G ident (null FK)", () => {
    const result = displaySpecies(
      { species: "Leopardus pardalis", confidence: 0.12, classifierModelId: null },
      modelById,
    );
    expect(result).toEqual({ label: "Leopardus pardalis", lowConfidence: false });
  });

  it("returns species when confidence is at or above threshold", () => {
    expect(
      displaySpecies(
        { species: "Puma concolor", confidence: 0.55, classifierModelId: 1 },
        modelById,
      ),
    ).toEqual({ label: "Puma concolor", lowConfidence: false });

    expect(
      displaySpecies(
        { species: "Puma concolor", confidence: 0.95, classifierModelId: 1 },
        modelById,
      ),
    ).toEqual({ label: "Puma concolor", lowConfidence: false });
  });

  it("returns Sin identificar when confidence is below threshold", () => {
    const result = displaySpecies(
      { species: "Tinamus major", confidence: 0.4, classifierModelId: 1 },
      modelById,
    );
    expect(result.label).toBe(LOW_CONFIDENCE_LABEL);
    expect(result.lowConfidence).toBe(true);
  });

  it("uses the per-model threshold (not a global)", () => {
    // 0.7 is below model 2 (0.9) but above model 1 (0.55)
    const m1 = displaySpecies(
      { species: "Mazama americana", confidence: 0.7, classifierModelId: 1 },
      modelById,
    );
    const m2 = displaySpecies(
      { species: "Mazama americana", confidence: 0.7, classifierModelId: 2 },
      modelById,
    );
    expect(m1.lowConfidence).toBe(false);
    expect(m2.lowConfidence).toBe(true);
  });

  it("falls back to raw when FK references a missing model row", () => {
    const result = displaySpecies(
      { species: "Cuniculus paca", confidence: 0.1, classifierModelId: 999 },
      modelById,
    );
    expect(result).toEqual({ label: "Cuniculus paca", lowConfidence: false });
  });
});
