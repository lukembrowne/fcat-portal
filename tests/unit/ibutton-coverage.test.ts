import { describe, it, expect } from "vitest";
import {
  computeCoverage,
  computeMaxGapSeconds,
  formatDuration,
  LOW_COVERAGE_THRESHOLD,
} from "@/app/biochoco/ibutton/coverage";

describe("computeCoverage", () => {
  it("computes 100% for a clean 30-min window", () => {
    // 10h window at 30 min → 21 readings (inclusive)
    const r = computeCoverage({
      odkDeployAt: "2026-03-01 09:00:00",
      odkRetrieveAt: "2026-03-01 19:00:00",
      sampleRate: "30 min",
      rowsImported: 21,
      dateRangeStart: "2026-03-01 09:00:00",
      dateRangeEnd: "2026-03-01 19:00:00",
    });
    expect(r.intervalSeconds).toBe(1800);
    expect(r.expectedReadings).toBe(21);
    expect(r.coveragePct).toBe(100);
    expect(r.hasLowCoverage).toBe(false);
  });

  it("flags low coverage when rowsImported is roughly half", () => {
    const r = computeCoverage({
      odkDeployAt: "2026-03-01 00:00:00",
      odkRetrieveAt: "2026-03-02 00:00:00",
      sampleRate: "1 hr",
      rowsImported: 12, // expected 25
      dateRangeStart: "2026-03-01 00:00:00",
      dateRangeEnd: "2026-03-01 12:00:00",
    });
    expect(r.expectedReadings).toBe(25);
    expect(r.coveragePct).toBe(48);
    expect(r.hasLowCoverage).toBe(true);
  });

  it("caps coverage at 100%", () => {
    const r = computeCoverage({
      odkDeployAt: "2026-03-01 09:00:00",
      odkRetrieveAt: "2026-03-01 10:00:00",
      sampleRate: "30 min",
      rowsImported: 100, // way more than expected
      dateRangeStart: "2026-03-01 09:00:00",
      dateRangeEnd: "2026-03-01 10:00:00",
    });
    expect(r.coveragePct).toBe(100);
    expect(r.hasLowCoverage).toBe(false);
  });

  it("falls back to derived interval when sample rate is unparseable", () => {
    const r = computeCoverage({
      odkDeployAt: "2026-03-01 00:00:00",
      odkRetrieveAt: "2026-03-01 02:00:00",
      sampleRate: "weird-thing",
      rowsImported: 5,
      // 2h / 4 intervals = 1800s → 30 min
      dateRangeStart: "2026-03-01 00:00:00",
      dateRangeEnd: "2026-03-01 02:00:00",
    });
    expect(r.intervalSeconds).toBe(1800);
    expect(r.expectedReadings).toBe(5);
    expect(r.coveragePct).toBe(100);
  });

  it("returns null coverage when ODK window is missing", () => {
    const r = computeCoverage({
      odkDeployAt: null,
      odkRetrieveAt: "2026-03-01 19:00:00",
      sampleRate: "30 min",
      rowsImported: 10,
      dateRangeStart: "2026-03-01 09:00:00",
      dateRangeEnd: "2026-03-01 14:00:00",
    });
    expect(r.coveragePct).toBeNull();
    expect(r.expectedReadings).toBeNull();
    expect(r.hasLowCoverage).toBe(false);
  });

  it("returns null coverage when sample rate is unparseable and rowsImported < 2", () => {
    const r = computeCoverage({
      odkDeployAt: "2026-03-01 09:00:00",
      odkRetrieveAt: "2026-03-01 19:00:00",
      sampleRate: "gibberish",
      rowsImported: 1,
      dateRangeStart: "2026-03-01 09:00:00",
      dateRangeEnd: "2026-03-01 09:00:00",
    });
    expect(r.intervalSeconds).toBeNull();
    expect(r.coveragePct).toBeNull();
  });

  it("hasLowCoverage threshold is LOW_COVERAGE_THRESHOLD - 1", () => {
    // 94 readings out of 100 → 94% → low
    const r = computeCoverage({
      odkDeployAt: "2026-03-01 00:00:00",
      odkRetrieveAt: "2026-03-01 01:39:00", // 99 minutes
      sampleRate: "1 min",
      rowsImported: 94,
      dateRangeStart: "2026-03-01 00:00:00",
      dateRangeEnd: "2026-03-01 01:33:00",
    });
    expect(r.expectedReadings).toBe(100);
    expect(r.coveragePct).toBe(94);
    expect(r.hasLowCoverage).toBe(true);
    expect(LOW_COVERAGE_THRESHOLD).toBe(95);
  });
});

describe("computeMaxGapSeconds", () => {
  it("returns null for fewer than 2 timestamps", () => {
    expect(computeMaxGapSeconds([])).toBeNull();
    expect(computeMaxGapSeconds(["2026-03-01 00:00:00"])).toBeNull();
  });

  it("finds the max gap between consecutive timestamps", () => {
    const result = computeMaxGapSeconds([
      "2026-03-01 00:00:00",
      "2026-03-01 00:30:00", // 30 min gap
      "2026-03-01 02:00:00", // 90 min gap ← max
      "2026-03-01 02:15:00", // 15 min gap
    ]);
    expect(result).toBe(90 * 60);
  });

  it("returns 0 for identical timestamps", () => {
    expect(
      computeMaxGapSeconds(["2026-03-01 00:00:00", "2026-03-01 00:00:00"])
    ).toBe(0);
  });
});

describe("formatDuration", () => {
  it("formats seconds", () => {
    expect(formatDuration(30)).toBe("30s");
  });
  it("formats minutes", () => {
    expect(formatDuration(5 * 60)).toBe("5m");
    expect(formatDuration(5 * 60 + 10)).toBe("5m 10s");
    expect(formatDuration(45 * 60)).toBe("45m");
  });
  it("formats hours + minutes", () => {
    expect(formatDuration(2 * 3600 + 15 * 60)).toBe("2h 15m");
    expect(formatDuration(3 * 3600)).toBe("3h");
  });
  it("formats days + hours", () => {
    expect(formatDuration(3 * 86400 + 2 * 3600)).toBe("3d 2h");
    expect(formatDuration(86400)).toBe("1d");
  });
  it("handles null and negative", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(-1)).toBe("—");
    expect(formatDuration(0)).toBe("0s");
  });
});
