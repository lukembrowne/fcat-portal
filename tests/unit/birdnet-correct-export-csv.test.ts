import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/habitat-lookup", () => ({
  extractSiteIdFromDeploymentName: vi.fn(),
  loadSiteHabitatMap: vi.fn(),
  resolveHabitatForDeployment: vi.fn(),
  UNKNOWN_HABITAT_KEY: "unknown",
}));

import {
  buildCorrectDetectionsCsv,
  CORRECT_EXPORT_COLUMNS,
  toIsoWithOffset,
  withinWindow,
  type CorrectDetectionRow,
} from "@/lib/birdnet-validation/correct-export";

function row(over: Partial<CorrectDetectionRow> = {}): CorrectDetectionRow {
  return {
    species: "Tinamus major",
    commonName: "Great Tinamou",
    spanishName: "Tinamú grande",
    campaignId: 1,
    campaignStatus: "fitted",
    sampleId: 10,
    audioIdentificationId: 20,
    detectionId: 30,
    deploymentId: 40,
    deploymentName: "CCN-003_V1",
    projectName: "BioChoco",
    siteId: "CCN-003",
    latitude: 0.1,
    longitude: -79.6,
    habitat: "cacao_ccn",
    habitatSource: "odk",
    recordingFile: "2MM21842_20260130_060000.flac",
    driveFileId: "abc",
    detectionStartS: 12,
    detectionEndS: 15,
    detectionLocal: "2026-01-30 06:00:12",
    inDeploymentWindow: true,
    birdnetConfidence: 0.61,
    scoreBin: 5,
    modelVersion: "birdnet-analyzer@2.4.0",
    reviewersCorrect: ["me@fcat-ecuador.org", "other@fcat-ecuador.org"],
    nCorrect: 2,
    nIncorrect: 1,
    nUncertain: 0,
    lastReviewedAt: new Date("2026-09-01T12:00:00Z"),
    ...over,
  };
}

describe("toIsoWithOffset", () => {
  it("marks Ecuador local time with its fixed UTC-5 offset", () => {
    expect(toIsoWithOffset("2025-11-23 09:00:58")).toBe("2025-11-23T09:00:58-05:00");
  });
  it("keeps a missing timestamp missing", () => {
    expect(toIsoWithOffset(null)).toBeNull();
  });
});

describe("withinWindow", () => {
  const start = "2026-01-24T09:42";
  const end = "2026-02-12T11:30";
  it("is true inside the window and at its edges", () => {
    expect(withinWindow("2026-01-30 06:00:12", start, end)).toBe(true);
    expect(withinWindow("2026-01-24 09:42:00", start, end)).toBe(true);
    expect(withinWindow("2026-02-12 11:30:59", start, end)).toBe(true);
  });
  it("is false before the start or after the end", () => {
    expect(withinWindow("2025-11-23 09:00:58", start, end)).toBe(false);
    expect(withinWindow("2026-02-12 11:31:00", start, end)).toBe(false);
  });
  it("checks a single known bound", () => {
    expect(withinWindow("2025-11-23 09:00:58", start, null)).toBe(false);
    expect(withinWindow("2026-03-01 00:00:00", start, null)).toBe(true);
  });
  it("treats a date-only bound as the whole day", () => {
    expect(withinWindow("2026-02-12 23:00:00", null, "2026-02-12")).toBe(true);
  });
  it("is unknown, not true, when no bound or no timestamp exists", () => {
    expect(withinWindow("2026-01-30 06:00:12", null, null)).toBeNull();
    expect(withinWindow(null, start, end)).toBeNull();
  });
});

describe("buildCorrectDetectionsCsv", () => {
  it("starts with the header row (after the Excel BOM), no comment lines", () => {
    const csv = buildCorrectDetectionsCsv([row()]);
    expect(csv.startsWith("\uFEFF" + CORRECT_EXPORT_COLUMNS.join(",") + "\n")).toBe(true);
    expect(csv).not.toMatch(/^#/m);
    const lines = csv.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1].split(",")).toHaveLength(CORRECT_EXPORT_COLUMNS.length);
  });

  it("splits the detection into date, time and an offset ISO timestamp", () => {
    const data = buildCorrectDetectionsCsv([row()]).trimEnd().split("\n").at(-1)!;
    expect(data).toContain("2026-01-30 06:00:12,2026-01-30T06:00:12-05:00,2026-01-30,06:00:12");
  });

  it("lists every reviewer who said correct, with the answer counts", () => {
    const data = buildCorrectDetectionsCsv([row()]).trimEnd().split("\n").at(-1)!;
    expect(data).toContain("me@fcat-ecuador.org; other@fcat-ecuador.org,2,1,0,");
  });

  it("quotes values containing commas or quotes", () => {
    const csv = buildCorrectDetectionsCsv([row({ projectName: 'Choco, "north"' })]);
    expect(csv).toContain('"Choco, ""north"""');
  });
});
