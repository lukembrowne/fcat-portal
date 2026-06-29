import { describe, expect, it } from "vitest";
import {
  mergeDeploymentSpeciesRows,
  type DeploymentSpeciesBranchRow,
} from "@/db/effective-species";

/**
 * Unit tests for the JS merge step of `aggregateAudioSpeciesForDeployment`.
 * The SQL branch queries are not exercised here (the repo has no in-memory DB
 * harness); the effective-species WHERE semantics are enforced in SQL by
 * `activeIdentification` / `correctedIdentification` / `applyConfidenceFilter`.
 * What this file proves is the count + weighted-confidence math that runs after
 * the two branches return.
 */

function row(over: Partial<DeploymentSpeciesBranchRow>): DeploymentSpeciesBranchRow {
  return { name: "Sp", count: 0, sumConf: null, confCount: 0, ...over };
}

describe("mergeDeploymentSpeciesRows", () => {
  it("returns one entry per distinct effective species with summed counts", () => {
    const out = mergeDeploymentSpeciesRows([
      row({ name: "Tinamus major", count: 5, sumConf: 4.0, confCount: 5 }),
      row({ name: "Ramphastos ambiguus", count: 3, sumConf: 2.4, confCount: 3 }),
    ]);
    expect(out).toHaveLength(2);
    const byName = new Map(out.map((s) => [s.scientificName, s]));
    expect(byName.get("Tinamus major")?.detectionCount).toBe(5);
    expect(byName.get("Ramphastos ambiguus")?.detectionCount).toBe(3);
  });

  it("merges active + corrected branch rows under the same effective name", () => {
    // Corrected rows already carry the corrected_species as `name`, so a
    // corrected-to-X row sums into species X alongside active-X rows.
    const out = mergeDeploymentSpeciesRows([
      row({ name: "Tinamus major", count: 4, sumConf: 3.2, confCount: 4 }),
      row({ name: "Tinamus major", count: 2, sumConf: 1.0, confCount: 2 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].detectionCount).toBe(6);
    // weighted mean = (3.2 + 1.0) / (4 + 2)
    expect(out[0].avgConfidence).toBeCloseTo(4.2 / 6, 10);
  });

  it("computes avgConfidence as a count-weighted mean of non-null confidences", () => {
    const out = mergeDeploymentSpeciesRows([
      row({ name: "Sp", count: 10, sumConf: 8.0, confCount: 10 }),
    ]);
    expect(out[0].avgConfidence).toBeCloseTo(0.8, 10);
  });

  it("excludes null-confidence rows from the average but keeps their count", () => {
    // One null-confidence (manual) row + scored rows: count includes the manual
    // detection, but the average is over the 4 scored rows only.
    const out = mergeDeploymentSpeciesRows([
      row({ name: "Sp", count: 4, sumConf: 3.6, confCount: 4 }),
      row({ name: "Sp", count: 1, sumConf: null, confCount: 0 }),
    ]);
    expect(out[0].detectionCount).toBe(5);
    expect(out[0].avgConfidence).toBeCloseTo(3.6 / 4, 10);
  });

  it("yields null avgConfidence when every contributing row is null-confidence", () => {
    const out = mergeDeploymentSpeciesRows([
      row({ name: "Sp", count: 3, sumConf: null, confCount: 0 }),
    ]);
    expect(out[0].detectionCount).toBe(3);
    expect(out[0].avgConfidence).toBeNull();
  });

  it("drops rows with a null effective name", () => {
    const out = mergeDeploymentSpeciesRows([
      row({ name: null, count: 9, sumConf: 1, confCount: 1 }),
      row({ name: "Sp", count: 2, sumConf: 1.4, confCount: 2 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].scientificName).toBe("Sp");
  });

  it("returns an empty array for no rows", () => {
    expect(mergeDeploymentSpeciesRows([])).toEqual([]);
  });
});
