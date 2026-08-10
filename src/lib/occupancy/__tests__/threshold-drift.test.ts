import { describe, expect, it } from "vitest";

import {
  describeThresholdEs,
  diffSpeciesThresholds,
  parseRunSpeciesThresholds,
  shortThresholdEs,
  speciesThresholdChanged,
  thresholdFor,
} from "../threshold-drift";

describe("parseRunSpeciesThresholds", () => {
  it("reads a run snapshot", () => {
    const map = parseRunSpeciesThresholds('{"Aramides wolfi":0.632,"Ortalis erythroptera":0.1}');
    expect(map.get("Aramides wolfi")).toBeCloseTo(0.632);
    expect(map.get("Ortalis erythroptera")).toBeCloseTo(0.1);
  });

  it("treats NULL as no per-species thresholds", () => {
    // Both a run predating the column and one where everything was reverted
    // filtered every species at the global cut-off — an empty map either way.
    expect(parseRunSpeciesThresholds(null).size).toBe(0);
    expect(parseRunSpeciesThresholds(undefined).size).toBe(0);
    expect(parseRunSpeciesThresholds("").size).toBe(0);
  });

  it("degrades to empty on malformed or wrongly-shaped JSON", () => {
    expect(parseRunSpeciesThresholds("{not json").size).toBe(0);
    expect(parseRunSpeciesThresholds("[0.7]").size).toBe(0);
    expect(parseRunSpeciesThresholds("null").size).toBe(0);
  });

  it("drops non-numeric and non-finite values rather than passing them on", () => {
    const map = parseRunSpeciesThresholds('{"A":"0.7","B":null,"C":0.55}');
    expect([...map.keys()]).toEqual(["C"]);
  });
});

describe("thresholdFor", () => {
  it("returns null when the species falls back to the global threshold", () => {
    expect(thresholdFor(new Map(), "Tinamus major")).toBeNull();
    expect(thresholdFor(new Map([["Tinamus major", 0.4]]), "Tinamus major")).toBe(0.4);
  });
});

describe("diffSpeciesThresholds", () => {
  it("finds nothing when the run's snapshot matches today", () => {
    const a = new Map([["Aramides wolfi", 0.632]]);
    const b = new Map([["Aramides wolfi", 0.632]]);
    expect(diffSpeciesThresholds(a, b)).toEqual([]);
  });

  it("ignores float noise from the JSON round-trip", () => {
    const a = new Map([["A", 0.6321138144600001]]);
    const b = new Map([["A", 0.63211381446]]);
    expect(diffSpeciesThresholds(a, b)).toEqual([]);
  });

  it("reports a threshold applied after the run as 'added'", () => {
    // The Ortalis case: the run filtered at the global 0.70, then the species
    // was marked "sin filtro" (the 0.1 floor).
    const changes = diffSpeciesThresholds(new Map(), new Map([["Ortalis erythroptera", 0.1]]));
    expect(changes).toEqual([
      { species: "Ortalis erythroptera", atRun: null, now: 0.1, kind: "added" },
    ]);
  });

  it("reports a reverted threshold as 'removed'", () => {
    const changes = diffSpeciesThresholds(new Map([["A", 0.9]]), new Map());
    expect(changes).toEqual([{ species: "A", atRun: 0.9, now: null, kind: "removed" }]);
  });

  it("reports a re-fitted threshold as 'changed'", () => {
    const changes = diffSpeciesThresholds(new Map([["A", 0.9]]), new Map([["A", 0.75]]));
    expect(changes).toEqual([{ species: "A", atRun: 0.9, now: 0.75, kind: "changed" }]);
  });

  it("sorts by scientific name so the warning is stable across renders", () => {
    const changes = diffSpeciesThresholds(
      new Map(),
      new Map([
        ["Zenaida auriculata", 0.2],
        ["Aramides wolfi", 0.6],
        ["Momotus momota", 0.4],
      ]),
    );
    expect(changes.map((c) => c.species)).toEqual([
      "Aramides wolfi",
      "Momotus momota",
      "Zenaida auriculata",
    ]);
  });
});

describe("speciesThresholdChanged", () => {
  it("is false for a species nobody has validated", () => {
    expect(
      speciesThresholdChanged(new Map([["A", 0.5]]), new Map([["A", 0.5]]), "B"),
    ).toBe(false);
  });

  it("is true when only that species moved", () => {
    expect(speciesThresholdChanged(new Map(), new Map([["B", 0.1]]), "B")).toBe(true);
  });
});

describe("describeThresholdEs", () => {
  it("names the global fallback with its value", () => {
    expect(describeThresholdEs(null, 0.7)).toBe("el umbral global de 0.70");
  });

  it("never reports a no-filter decision as a threshold", () => {
    // 0.10 is the score floor: it keeps everything. Printing "umbral de 0.100"
    // would read as an unusually permissive fit — the opposite of the decision.
    const text = describeThresholdEs(0.1, 0.7, "no_filter");
    expect(text).toContain("sin filtro");
    expect(text).not.toContain("validado");
  });

  it("describes a floor value with no known source by what it does", () => {
    expect(describeThresholdEs(0.1, 0.7)).toContain("sin filtro efectivo");
  });

  it("shows a fitted threshold at three decimals", () => {
    expect(describeThresholdEs(0.63211381446, 0.7, "fit")).toBe(
      "el umbral validado de 0.632",
    );
  });
});

describe("shortThresholdEs", () => {
  it("compresses the three states", () => {
    expect(shortThresholdEs(null)).toBe("umbral global");
    expect(shortThresholdEs(0.1)).toBe("sin filtro");
    expect(shortThresholdEs(0.632)).toBe("0.632");
  });
});
