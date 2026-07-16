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

describe("buildSites — audio window: ODK install start, last-file end", () => {
  it("clamps a stray pre-install recording to the ODK install date and flags it", () => {
    // CCN-003 / NAC-006 pattern: a file captured weeks before the sensor was
    // placed would otherwise open the window early and balloon the matrix.
    const deployments = [dep({ id: 10, date_start: "2026-03-17", date_end: "2026-04-17" })];
    // Stray file on 2026-02-01 (pre-install); recorder died 2026-04-10 (battery).
    const windows = new Map([[10, { min: day("2026-02-01"), max: day("2026-04-10") }]]);

    const { sites, anomalies } = buildSites(deployments, windows, "audio");
    // Start = ODK install (clamps the stray), end = last file (battery death).
    expect(sites[0].windowStart.toISOString().slice(0, 10)).toBe("2026-03-17");
    expect(sites[0].windowEnd.toISOString().slice(0, 10)).toBe("2026-04-10");
    // The pre-install file is surfaced, not silently dropped.
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      siteId: "10",
      odkStart: "2026-03-17",
      fileMin: "2026-02-01",
      fileMax: "2026-04-10",
      noOverlap: false,
    });
  });

  it("ends at the last file when the recorder died before the ODK retrieve date", () => {
    const deployments = [dep({ id: 11, date_start: "2026-03-17", date_end: "2026-04-17" })];
    const windows = new Map([[11, { min: day("2026-03-17"), max: day("2026-04-05") }]]);

    const { sites, anomalies } = buildSites(deployments, windows, "audio");
    expect(sites[0].windowStart.toISOString().slice(0, 10)).toBe("2026-03-17");
    expect(sites[0].windowEnd.toISOString().slice(0, 10)).toBe("2026-04-05");
    // Files fall inside [install, last file] — nothing to flag.
    expect(anomalies).toHaveLength(0);
  });

  it("uses the ODK install date, never the camera-QA'd valid_* window", () => {
    // valid_* is trimmed from the CAMERA imagery; audio must not inherit it.
    const deployments = [
      dep({
        id: 12,
        date_start: "2026-02-24",
        date_end: "2026-03-25",
        valid_start: "2026-03-04",
        valid_end: "2026-03-12",
      }),
    ];
    const windows = new Map([[12, { min: day("2026-02-24"), max: day("2026-03-25") }]]);

    const { sites } = buildSites(deployments, windows, "audio");
    // ODK install (02-24), not valid_start (03-04).
    expect(sites[0].windowStart.toISOString().slice(0, 10)).toBe("2026-02-24");
    expect(sites[0].windowEnd.toISOString().slice(0, 10)).toBe("2026-03-25");
  });

  it("opens at ODK install when the recorder started late (leading absences)", () => {
    const deployments = [dep({ id: 13, date_start: "2026-04-01", date_end: "2026-04-30" })];
    // First file 2026-04-05 — recorder came online 4 days after install.
    const windows = new Map([[13, { min: day("2026-04-05"), max: day("2026-04-28") }]]);

    const { sites, anomalies } = buildSites(deployments, windows, "audio");
    expect(sites[0].windowStart.toISOString().slice(0, 10)).toBe("2026-04-01");
    expect(sites[0].windowEnd.toISOString().slice(0, 10)).toBe("2026-04-28");
    // Files fall inside [install, last file]; the leading gap is absence, not anomaly.
    expect(anomalies).toHaveLength(0);
  });

  it("falls back to the first file for the start when ODK install is missing", () => {
    const deployments = [dep({ id: 14, date_start: null, date_end: null })];
    const windows = new Map([[14, { min: day("2026-03-01"), max: day("2026-03-20") }]]);

    const { sites, anomalies } = buildSites(deployments, windows, "audio");
    expect(sites[0].windowStart.toISOString().slice(0, 10)).toBe("2026-03-01");
    expect(sites[0].windowEnd.toISOString().slice(0, 10)).toBe("2026-03-20");
    expect(anomalies).toHaveLength(0);
  });

  it("falls back to ODK dates when a deployment has no audio files", () => {
    const deployments = [dep({ id: 15, date_start: "2026-04-01", date_end: "2026-04-30" })];
    const { sites } = buildSites(deployments, new Map(), "audio");
    expect(sites[0].windowStart.toISOString().slice(0, 10)).toBe("2026-04-01");
    expect(sites[0].windowEnd.toISOString().slice(0, 10)).toBe("2026-04-30");
  });
});
