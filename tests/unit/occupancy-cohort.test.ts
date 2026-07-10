import { describe, it, expect } from "vitest";
import { getSyntheticSiteIds, cohortSitesFor } from "@/lib/occupancy/cohort";
import type { OccupancyStreamInputs } from "@/lib/occupancy/fetch";

// Minimal inputs: the cohort helpers only touch `sites[].siteId` and
// `covariateInputs.get(siteId)?.fieldNotes`. A synthetic OCC-SEED site carries
// an `occSeed` blob in field_notes; a real site does not.
function makeInputs(
  sites: { siteId: string; fieldNotes: string | null }[],
): OccupancyStreamInputs {
  return {
    sites: sites.map((s) => ({ siteId: s.siteId })),
    covariateInputs: new Map(sites.map((s) => [s.siteId, { fieldNotes: s.fieldNotes }])),
    detections: [],
    droppedSites: 0,
  } as unknown as OccupancyStreamInputs;
}

const seed = (forest: number, elevation: number) =>
  JSON.stringify({ occSeed: { forest, elevation } });

describe("occupancy cohort isolation", () => {
  it("finds no synthetic sites when none carry a seed blob (production)", () => {
    const inputs = makeInputs([
      { siteId: "1", fieldNotes: null },
      { siteId: "2", fieldNotes: '{"note":"real"}' },
    ]);
    expect(getSyntheticSiteIds(inputs).size).toBe(0);
  });

  it("identifies the seeded synthetic sites", () => {
    const inputs = makeInputs([
      { siteId: "1", fieldNotes: null },
      { siteId: "s1", fieldNotes: seed(0.8, 1200) },
      { siteId: "s2", fieldNotes: seed(0.2, 400) },
    ]);
    expect([...getSyntheticSiteIds(inputs)].sort()).toEqual(["s1", "s2"]);
  });

  it("returns the full pool when there are no synthetic sites", () => {
    const sites = [{ siteId: "1" }, { siteId: "2" }];
    const out = cohortSitesFor(sites, [{ siteId: "1" }], new Set<string>());
    expect(out).toEqual(sites);
  });

  it("restricts a synthetic-detected species to the synthetic cohort", () => {
    const sites = [{ siteId: "1" }, { siteId: "2" }, { siteId: "s1" }, { siteId: "s2" }];
    const synthetic = new Set(["s1", "s2"]);
    const out = cohortSitesFor(sites, [{ siteId: "s1" }], synthetic);
    expect(out.map((s) => s.siteId)).toEqual(["s1", "s2"]);
  });

  it("restricts a real-detected species to the real cohort", () => {
    const sites = [{ siteId: "1" }, { siteId: "2" }, { siteId: "s1" }, { siteId: "s2" }];
    const synthetic = new Set(["s1", "s2"]);
    const out = cohortSitesFor(sites, [{ siteId: "2" }], synthetic);
    expect(out.map((s) => s.siteId)).toEqual(["1", "2"]);
  });
});
