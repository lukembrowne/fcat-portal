import { describe, it, expect } from "vitest";
import {
  buildAudioSubsampleReport,
  formatCadenceLabel,
  isDegenerateSubsample,
} from "@/lib/occupancy/audio-subsample-report";
import type { AudioSubsampleSummary } from "@/lib/occupancy/audio-subsample";
import type { OccupancySite } from "@/lib/occupancy/detection-history";

const day = (s: string) => new Date(`${s}T00:00:00Z`);
const site = (id: number, name: string): OccupancySite => ({
  siteId: String(id),
  siteName: name,
  latitude: 0.4,
  longitude: -79.6,
  windowStart: day("2026-03-01"),
  windowEnd: day("2026-03-05"),
});

function summary(
  rows: Array<{
    deploymentId: number;
    nativeCadenceSeconds: number | null;
    filesTotal: number;
    filesKept: number;
    filesDropped: number;
    filesUnparsed: number;
  }>,
): AudioSubsampleSummary {
  const byDeployment = new Map(rows.map((r) => [r.deploymentId, r]));
  return {
    bucketMinutes: 10,
    filesTotal: rows.reduce((n, r) => n + r.filesTotal, 0),
    filesKept: rows.reduce((n, r) => n + r.filesKept, 0),
    filesDropped: rows.reduce((n, r) => n + r.filesDropped, 0),
    filesUnparsed: rows.reduce((n, r) => n + r.filesUnparsed, 0),
    byDeployment,
  };
}

describe("formatCadenceLabel", () => {
  it("maps modal gaps to Spanish cadence labels", () => {
    expect(formatCadenceLabel(300)).toBe("5 min");
    expect(formatCadenceLabel(600)).toBe("10 min");
    expect(formatCadenceLabel(580)).toBe("10 min"); // within the 10-min jitter band
    expect(formatCadenceLabel(900)).toBe("~15 min"); // outside both bands → derived label
    expect(formatCadenceLabel(null)).toBe("sin datos");
  });
});

describe("isDegenerateSubsample", () => {
  it("flags a dense-cadence deployment with zero drops", () => {
    expect(
      isDegenerateSubsample({ nativeCadenceSeconds: 300, filesTotal: 100, filesDropped: 0, filesUnparsed: 0 }),
    ).toBe(true);
  });

  it("flags a mostly-unparsed deployment", () => {
    expect(
      isDegenerateSubsample({ nativeCadenceSeconds: null, filesTotal: 10, filesDropped: 0, filesUnparsed: 8 }),
    ).toBe(true);
  });

  it("does not flag a healthy 5-min deployment that was halved", () => {
    expect(
      isDegenerateSubsample({ nativeCadenceSeconds: 300, filesTotal: 100, filesDropped: 50, filesUnparsed: 0 }),
    ).toBe(false);
  });

  it("does not flag a clean 10-min deployment with zero drops", () => {
    expect(
      isDegenerateSubsample({ nativeCadenceSeconds: 600, filesTotal: 100, filesDropped: 0, filesUnparsed: 0 }),
    ).toBe(false);
  });
});

describe("buildAudioSubsampleReport", () => {
  it("returns null for a stream with no summary (camera)", () => {
    expect(buildAudioSubsampleReport(undefined, [])).toBeNull();
  });

  it("scopes rows to the modeled site pool and recomputes totals", () => {
    const s = summary([
      { deploymentId: 1, nativeCadenceSeconds: 300, filesTotal: 100, filesKept: 50, filesDropped: 50, filesUnparsed: 0 },
      // deployment 2 is NOT in the pool (excluded/unverified) → must be dropped
      { deploymentId: 2, nativeCadenceSeconds: 300, filesTotal: 80, filesKept: 40, filesDropped: 40, filesUnparsed: 0 },
    ]);
    const report = buildAudioSubsampleReport(s, [site(1, "IN-POOL")])!;
    expect(report.deployments).toHaveLength(1);
    expect(report.deployments[0].deploymentId).toBe(1);
    expect(report.deployments[0].siteName).toBe("IN-POOL");
    // totals reflect only the pooled deployment, not deployment 2
    expect(report.filesTotal).toBe(100);
    expect(report.filesDropped).toBe(50);
  });

  it("orders deployments by files dropped (most affected first)", () => {
    const s = summary([
      { deploymentId: 1, nativeCadenceSeconds: 600, filesTotal: 60, filesKept: 60, filesDropped: 0, filesUnparsed: 0 },
      { deploymentId: 2, nativeCadenceSeconds: 300, filesTotal: 100, filesKept: 50, filesDropped: 50, filesUnparsed: 0 },
    ]);
    const report = buildAudioSubsampleReport(s, [site(1, "A"), site(2, "B")])!;
    expect(report.deployments.map((d) => d.deploymentId)).toEqual([2, 1]);
  });

  it("carries the degenerate flag through to the row", () => {
    const s = summary([
      { deploymentId: 1, nativeCadenceSeconds: 300, filesTotal: 100, filesKept: 100, filesDropped: 0, filesUnparsed: 0 },
    ]);
    const report = buildAudioSubsampleReport(s, [site(1, "STUCK")])!;
    expect(report.deployments[0].degenerate).toBe(true);
  });
});
