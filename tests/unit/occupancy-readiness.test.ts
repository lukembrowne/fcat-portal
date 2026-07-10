import { describe, it, expect } from "vitest";
import { computeReadiness, type ReadinessDetection } from "@/lib/occupancy/readiness";
import type { OccupancySite } from "@/lib/occupancy/detection-history";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

function sites(n: number, withCoords = n): OccupancySite[] {
  return Array.from({ length: n }, (_, i) => ({
    siteId: `S${i}`,
    siteName: `Sitio ${i}`,
    latitude: i < withCoords ? 0.4 : null,
    longitude: i < withCoords ? -79.6 : null,
    windowStart: utc(2026, 1, 1),
    windowEnd: utc(2026, 1, 25),
  }));
}

describe("computeReadiness", () => {
  it("mirrors the current-DB reality: many detections, 1 hotspot site → ineligible", () => {
    const s = sites(20);
    const dets: ReadinessDetection[] = Array.from({ length: 200 }, () => ({
      species: "Dasyprocta punctata",
      siteId: "S0",
      captureDay: utc(2026, 1, 3),
    }));
    const report = computeReadiness(s, dets, { stream: "camera" });
    expect(report.nSites).toBe(20);
    expect(report.nSpecies).toBe(1);
    expect(report.nEligibleSpecies).toBe(0);
    const row = report.species[0];
    expect(row.eligible).toBe(false);
    expect(row.nSitesDetected).toBe(1);
    expect(row.reasons.some((r) => r.includes("concentradas"))).toBe(true);
  });

  it("marks a well-spread species eligible and sorts eligible species first", () => {
    const s = sites(20);
    const spread: ReadinessDetection[] = [];
    // Species A: detected across 6 sites — eligible.
    for (let i = 0; i < 6; i++)
      for (let o = 0; o < 2; o++)
        spread.push({ species: "A", siteId: `S${i}`, captureDay: utc(2026, 1, 2 + o * 6) });
    // Species B: one site — ineligible.
    spread.push({ species: "B", siteId: "S0", captureDay: utc(2026, 1, 2) });

    const report = computeReadiness(s, spread, { stream: "camera" });
    expect(report.nEligibleSpecies).toBe(1);
    expect(report.species[0].species).toBe("A"); // eligible sorts first
    expect(report.species[0].eligible).toBe(true);
    expect(report.species[1].species).toBe("B");
    expect(report.species[1].eligible).toBe(false);
  });

  it("reports coordinate coverage separately from survey window coverage", () => {
    const s = sites(10, 4); // 10 sites, only 4 with coords
    const report = computeReadiness(s, [], { stream: "audio", confidenceThreshold: 0.7 });
    expect(report.nSites).toBe(10);
    expect(report.nSitesWithCoords).toBe(4);
    expect(report.confidenceThreshold).toBe(0.7);
  });
});
