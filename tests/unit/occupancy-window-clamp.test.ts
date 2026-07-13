import { describe, it, expect, vi } from "vitest";

// buildSites lives in a "server-only" module that imports the db singleton and
// logger; stub those so the pure window-derivation logic can be unit-tested.
vi.mock("server-only", () => ({}));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { buildSites, type DeploymentRow } from "@/lib/occupancy/fetch";

const day = (s: string) => new Date(`${s}T00:00:00Z`);

function dep(overrides: Partial<DeploymentRow> & { id: number }): DeploymentRow {
  return {
    site_name: `Site ${overrides.id}`,
    name: `DEP-${overrides.id}`,
    latitude: -0.1,
    longitude: -79.1,
    date_start: null,
    date_end: null,
    field_notes: null,
    ...overrides,
  };
}

describe("buildSites — strict ODK date clamp + anomaly", () => {
  it("clamps the window to the ODK dates and ignores wider file dates", () => {
    const deployments = [dep({ id: 1, date_start: "2026-01-01", date_end: "2026-01-10" })];
    // A stray file dated far outside the real deployment window on both sides.
    const windows = new Map([[1, { min: day("2025-06-01"), max: day("2026-12-31") }]]);

    const { sites, anomalies } = buildSites(deployments, windows);

    expect(sites).toHaveLength(1);
    expect(sites[0].windowStart.toISOString().slice(0, 10)).toBe("2026-01-01");
    expect(sites[0].windowEnd.toISOString().slice(0, 10)).toBe("2026-01-10");
    // Files spill outside the window on both sides but still overlap it.
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      siteId: "1",
      odkStart: "2026-01-01",
      odkEnd: "2026-01-10",
      fileMin: "2025-06-01",
      fileMax: "2026-12-31",
      noOverlap: false,
    });
  });

  it("flags noOverlap when the file dates and ODK window are disjoint", () => {
    const deployments = [dep({ id: 2, date_start: "2026-01-01", date_end: "2026-01-10" })];
    const windows = new Map([[2, { min: day("2025-01-01"), max: day("2025-02-01") }]]);

    const { sites, anomalies } = buildSites(deployments, windows);

    expect(sites[0].windowStart.toISOString().slice(0, 10)).toBe("2026-01-01");
    expect(anomalies[0].noOverlap).toBe(true);
  });

  it("does not flag when file dates fall inside the ODK window", () => {
    const deployments = [dep({ id: 3, date_start: "2026-01-01", date_end: "2026-01-31" })];
    const windows = new Map([[3, { min: day("2026-01-05"), max: day("2026-01-20") }]]);

    const { anomalies } = buildSites(deployments, windows);
    expect(anomalies).toHaveLength(0);
  });

  it("falls back to file-derived dates (no anomaly) when ODK dates are missing", () => {
    const deployments = [dep({ id: 4, date_start: null, date_end: null })];
    const windows = new Map([[4, { min: day("2026-03-01"), max: day("2026-03-20") }]]);

    const { sites, anomalies } = buildSites(deployments, windows);
    expect(sites[0].windowStart.toISOString().slice(0, 10)).toBe("2026-03-01");
    expect(sites[0].windowEnd.toISOString().slice(0, 10)).toBe("2026-03-20");
    expect(anomalies).toHaveLength(0);
  });

  it("drops a deployment with neither ODK dates nor file dates", () => {
    const deployments = [dep({ id: 5, date_start: null, date_end: null })];
    const { sites } = buildSites(deployments, new Map());
    expect(sites).toHaveLength(0);
  });
});
