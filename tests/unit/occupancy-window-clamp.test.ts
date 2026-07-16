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
    valid_start: null,
    valid_end: null,
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

  it("prefers the QA-validated window over the wider ODK install/retrieve window", () => {
    // Retrieved on schedule after 30 days, but the camera only recorded 8 —
    // the reviewer trimmed valid_* to the real sampling span (cf. GIZ-004).
    const deployments = [
      dep({
        id: 6,
        date_start: "2026-02-24",
        date_end: "2026-03-25",
        valid_start: "2026-03-04T09:59",
        valid_end: "2026-03-12T10:35",
      }),
    ];
    const windows = new Map([[6, { min: day("2026-03-04"), max: day("2026-03-12") }]]);

    const { sites } = buildSites(deployments, windows);
    expect(sites[0].windowStart.toISOString().slice(0, 10)).toBe("2026-03-04");
    expect(sites[0].windowEnd.toISOString().slice(0, 10)).toBe("2026-03-12");
  });

  it("resolves each bound independently (valid_end fills in for a null date_end)", () => {
    // date_end is null (retrieval not yet synced) but the reviewer set valid_end.
    const deployments = [
      dep({ id: 7, date_start: "2026-05-20", date_end: null, valid_end: "2026-06-20T02:18" }),
    ];
    const windows = new Map([[7, { min: day("2026-05-20"), max: day("2026-06-20") }]]);

    const { sites } = buildSites(deployments, windows);
    expect(sites[0].windowStart.toISOString().slice(0, 10)).toBe("2026-05-20");
    expect(sites[0].windowEnd.toISOString().slice(0, 10)).toBe("2026-06-20");
  });
});

describe("buildSites — audio stream uses file stamps, ignores valid_*", () => {
  it("takes the audio file min/max, not the camera-QA'd valid_* window", () => {
    // The camera was trimmed to 8 days (valid_*), but the recorder ran its own
    // span. Audio must use its filename-derived min/max, not the camera trim.
    const deployments = [
      dep({
        id: 10,
        date_start: "2026-02-24",
        date_end: "2026-03-25",
        valid_start: "2026-03-04",
        valid_end: "2026-03-12",
      }),
    ];
    const windows = new Map([[10, { min: day("2026-02-24"), max: day("2026-03-25") }]]);

    const { sites, anomalies } = buildSites(deployments, windows, "audio");
    expect(sites[0].windowStart.toISOString().slice(0, 10)).toBe("2026-02-24");
    expect(sites[0].windowEnd.toISOString().slice(0, 10)).toBe("2026-03-25");
    // File span IS the window for audio, so there is nothing to flag.
    expect(anomalies).toHaveLength(0);
  });

  it("falls back to ODK dates when a deployment has no audio files", () => {
    const deployments = [dep({ id: 11, date_start: "2026-04-01", date_end: "2026-04-30" })];
    const { sites } = buildSites(deployments, new Map(), "audio");
    expect(sites[0].windowStart.toISOString().slice(0, 10)).toBe("2026-04-01");
    expect(sites[0].windowEnd.toISOString().slice(0, 10)).toBe("2026-04-30");
  });
});
