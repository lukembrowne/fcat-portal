import { describe, it, expect } from "vitest";

import {
  PLOT_SITE_PAIRS,
  plotForSite,
  siteForPlot,
  siteCodeFromDeploymentName,
} from "../plot-site-map";

describe("PLOT_SITE_PAIRS", () => {
  it("covers all 16 plots with no gaps", () => {
    const ids = PLOT_SITE_PAIRS.map((p) => p.plotId).sort();
    const expected = Array.from({ length: 16 }, (_, i) =>
      `P${String(i + 1).padStart(2, "0")}`,
    );
    expect(ids).toEqual(expected);
  });

  it("has unique plot identifiers and unique site codes", () => {
    expect(new Set(PLOT_SITE_PAIRS.map((p) => p.plotId)).size).toBe(16);
    expect(new Set(PLOT_SITE_PAIRS.map((p) => p.siteCode)).size).toBe(16);
  });

  it("has no blank values", () => {
    for (const pair of PLOT_SITE_PAIRS) {
      expect(pair.plotId.trim()).not.toBe("");
      expect(pair.siteCode.trim()).not.toBe("");
    }
  });

  it("matches the plot identifier format", () => {
    for (const pair of PLOT_SITE_PAIRS) {
      expect(pair.plotId).toMatch(/^P\d{2}$/);
    }
  });

  it("keeps the REF-00N -> P0N correspondence for treatment plots", () => {
    // P08 is a control, which is why there is no REF-008 — the one place the
    // otherwise-mechanical numbering breaks.
    for (const n of [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13]) {
      const plotId = `P${String(n).padStart(2, "0")}`;
      expect(siteForPlot(plotId)).toBe(`REF-${String(n).padStart(3, "0")}`);
    }
    expect(siteForPlot("P08")).toBe("SEC-002");
    expect(PLOT_SITE_PAIRS.some((p) => p.siteCode === "REF-008")).toBe(false);
  });

  it("maps the four control plots to their habitat-coded sites", () => {
    expect(siteForPlot("P08")).toBe("SEC-002");
    expect(siteForPlot("P14")).toBe("PRI-003");
    expect(siteForPlot("P15")).toBe("SEC-001");
    expect(siteForPlot("P16")).toBe("PRI-002");
  });
});

describe("lookups", () => {
  it("resolves in both directions", () => {
    expect(plotForSite("REF-007")).toBe("P07");
    expect(siteForPlot("P07")).toBe("REF-007");
  });

  it("returns undefined for a site outside the experiment rather than throwing", () => {
    expect(plotForSite("CCN-010")).toBeUndefined();
    expect(plotForSite("")).toBeUndefined();
  });

  it("returns undefined for a plot outside the experiment", () => {
    expect(siteForPlot("P17")).toBeUndefined();
    expect(siteForPlot("I10-P5")).toBeUndefined();
  });
});

describe("siteCodeFromDeploymentName", () => {
  it("strips the visit suffix", () => {
    expect(siteCodeFromDeploymentName("REF-007_V1")).toBe("REF-007");
    expect(siteCodeFromDeploymentName("PRI-002_V1")).toBe("PRI-002");
  });

  it("passes through a name with no suffix", () => {
    expect(siteCodeFromDeploymentName("REF-007")).toBe("REF-007");
  });

  it("tolerates surrounding whitespace", () => {
    expect(siteCodeFromDeploymentName("  REF-007_V1 ")).toBe("REF-007");
  });

  it("resolves every deployment name in the experiment to a mapped plot", () => {
    const names = [
      "REF-001_V1", "REF-002_V1", "REF-003_V1", "REF-004_V1", "REF-005_V1",
      "REF-006_V1", "REF-007_V1", "REF-009_V1", "REF-010_V1", "REF-011_V1",
      "REF-012_V1", "REF-013_V1", "PRI-002_V1", "PRI-003_V1", "SEC-001_V1",
    ];
    for (const name of names) {
      expect(plotForSite(siteCodeFromDeploymentName(name))).toBeDefined();
    }
  });
});
