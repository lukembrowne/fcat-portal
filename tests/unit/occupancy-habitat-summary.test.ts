import { describe, it, expect } from "vitest";
import { naiveOccupancyByHabitat } from "@/lib/occupancy/habitat-summary";
import type { SitePerRow } from "@/lib/occupancy/detection-history";

// Minimal per-site rows — the tally only reads siteId + detected.
function site(siteId: string, detected: boolean): Pick<SitePerRow, "siteId" | "detected"> {
  return { siteId, detected };
}

describe("naiveOccupancyByHabitat", () => {
  it("tallies detected/surveyed per habitat and sorts by observed occupancy", () => {
    // Chicken-like: all detections in Cacao, none in forest.
    const perSite = [
      site("1", true),
      site("2", true),
      site("3", false), // Cacao, not detected
      site("4", false),
      site("5", false), // Bosque, never detected
    ];
    const habitat = new Map<string, string | null>([
      ["1", "Cacao"],
      ["2", "Cacao"],
      ["3", "Cacao"],
      ["4", "Bosque"],
      ["5", "Bosque"],
    ]);
    const rows = naiveOccupancyByHabitat(perSite, habitat);
    expect(rows).toEqual([
      { habitat: "Cacao", nSurveyed: 3, nDetected: 2, naiveOccupancy: 2 / 3 },
      { habitat: "Bosque", nSurveyed: 2, nDetected: 0, naiveOccupancy: 0 },
    ]);
  });

  it("omits sites with an unresolved habitat", () => {
    const perSite = [site("1", true), site("2", true), site("3", false)];
    const habitat = new Map<string, string | null>([
      ["1", "Cacao"],
      ["2", null], // unresolved → skipped
      // site 3 absent from map → undefined → skipped
    ]);
    const rows = naiveOccupancyByHabitat(perSite, habitat);
    expect(rows).toEqual([{ habitat: "Cacao", nSurveyed: 1, nDetected: 1, naiveOccupancy: 1 }]);
  });

  it("breaks ties on site count then habitat name", () => {
    // Two habitats both at 50% occupancy; more sites first, then A→Z.
    const perSite = [
      site("1", true),
      site("2", false),
      site("3", true),
      site("4", false),
      site("5", true),
      site("6", false),
    ];
    const habitat = new Map<string, string | null>([
      ["1", "Zebra"],
      ["2", "Zebra"],
      ["3", "Alpha"],
      ["4", "Alpha"],
      ["5", "Alpha"],
      ["6", "Alpha"],
    ]);
    const rows = naiveOccupancyByHabitat(perSite, habitat);
    expect(rows.map((r) => r.habitat)).toEqual(["Alpha", "Zebra"]);
  });

  it("returns an empty array when no site has a habitat", () => {
    const rows = naiveOccupancyByHabitat([site("1", true)], new Map());
    expect(rows).toEqual([]);
  });
});
