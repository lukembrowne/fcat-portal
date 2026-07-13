import { describe, it, expect } from "vitest";
import {
  parseCaptureDayFromFilename,
  parseCaptureDayFromExif,
  parseCaptureDayFromFileModified,
  resolveCaptureDay,
  daysBetween,
  addDays,
} from "@/lib/occupancy/capture-date";
import {
  computeOccasions,
  occasionIndexForDay,
  effortLevel,
  occasionEndDay,
} from "@/lib/occupancy/occasions";
import {
  fitStandardization,
  standardizeValue,
  backTransformValue,
  standardizeArray,
} from "@/lib/occupancy/standardize";
import {
  buildDetectionFrame,
  type OccupancySite,
  type SpeciesDetectionEvent,
} from "@/lib/occupancy/detection-history";
import { assessEligibility, DEFAULT_THRESHOLDS } from "@/lib/occupancy/eligibility";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

describe("capture-date", () => {
  it("parses the YYYYMMDD token from a real camera-trap filename", () => {
    const d = parseCaptureDayFromFilename("Uno - 20130708 - MFDC0007.JPG");
    expect(d).toEqual(utc(2013, 7, 8));
  });

  it("returns null when no plausible date token exists", () => {
    expect(parseCaptureDayFromFilename("IMG_0007.JPG")).toBeNull();
    expect(parseCaptureDayFromFilename("MFDC0007")).toBeNull();
    expect(parseCaptureDayFromFilename(null)).toBeNull();
  });

  it("rejects impossible calendar dates (no rollover)", () => {
    // 20130230 is not a real date; must not roll into March.
    expect(parseCaptureDayFromFilename("cam - 20130230 - x.jpg")).toBeNull();
    expect(parseCaptureDayFromFilename("cam - 20131399 - x.jpg")).toBeNull();
  });

  it("does not match 8-digit serials embedded in longer digit runs", () => {
    // 123201307089 has no isolated 8-digit token boundary.
    expect(parseCaptureDayFromFilename("serial123201307089end")).toBeNull();
  });

  it("falls back to exif when the filename has no date", () => {
    const d = resolveCaptureDay({
      filename: "IMG_0001.JPG",
      exifTimestamp: "2026-02-25T17:43:58.000Z",
    });
    expect(d).toEqual(utc(2026, 2, 25));
  });

  it("prefers filename over exif", () => {
    const d = resolveCaptureDay({
      filename: "x - 20240101 - y.jpg",
      exifTimestamp: "2026-02-25T17:43:58.000Z",
    });
    expect(d).toEqual(utc(2024, 1, 1));
  });

  it("parseCaptureDayFromExif handles bad input", () => {
    expect(parseCaptureDayFromExif("not-a-date")).toBeNull();
    expect(parseCaptureDayFromExif(null)).toBeNull();
  });

  it("falls back to file_modified for dateless filenames + no exif", () => {
    // 1777038230 = 2026-04-24 (prod dep-121 shape: HHMMSS_seq filename, no exif)
    const d = resolveCaptureDay({
      filename: "084348_0101.jpg",
      exifTimestamp: null,
      fileModified: 1777038230,
    });
    expect(d).toEqual(utc(2026, 4, 24));
  });

  it("prefers filename date over file_modified (legacy precedence)", () => {
    const d = resolveCaptureDay({
      filename: "x - 20240101 - y.jpg",
      fileModified: 1777038230, // 2026-04-24
    });
    expect(d).toEqual(utc(2024, 1, 1));
  });

  it("returns null when filename, exif and file_modified are all absent", () => {
    expect(resolveCaptureDay({ filename: "084348_0101.jpg" })).toBeNull();
    expect(resolveCaptureDay({ filename: "084348_0101.jpg", fileModified: null })).toBeNull();
  });

  it("parseCaptureDayFromFileModified reduces to a UTC day and rejects garbage epochs", () => {
    expect(parseCaptureDayFromFileModified(1777038230)).toEqual(utc(2026, 4, 24));
    // 0 → 1970, outside the 2000–2100 sanity bound → rejected
    expect(parseCaptureDayFromFileModified(0)).toBeNull();
    expect(parseCaptureDayFromFileModified(null)).toBeNull();
    expect(parseCaptureDayFromFileModified(Number.NaN)).toBeNull();
    // same UTC day regardless of sub-day time (13:43 and 15:59 of 2026-04-24)
    expect(parseCaptureDayFromFileModified(1777046399)).toEqual(utc(2026, 4, 24));
  });

  it("daysBetween / addDays are whole-day exact", () => {
    expect(daysBetween(utc(2026, 1, 1), utc(2026, 1, 6))).toBe(5);
    expect(addDays(utc(2026, 1, 1), 4)).toEqual(utc(2026, 1, 5));
  });
});

describe("occasions", () => {
  it("tiles an evenly divisible window", () => {
    const layout = computeOccasions(utc(2026, 1, 1), utc(2026, 1, 10), 5); // 10 days
    expect(layout.count).toBe(2);
    expect(layout.nDays).toEqual([5, 5]);
    expect(layout.totalDays).toBe(10);
  });

  it("keeps a ragged final bin instead of dropping it", () => {
    const layout = computeOccasions(utc(2026, 1, 1), utc(2026, 1, 12), 5); // 12 days
    expect(layout.count).toBe(3);
    expect(layout.nDays).toEqual([5, 5, 2]);
  });

  it("assigns capture days to the right occasion and rejects out-of-window", () => {
    const layout = computeOccasions(utc(2026, 1, 1), utc(2026, 1, 12), 5);
    expect(occasionIndexForDay(layout, utc(2026, 1, 1), 5)).toBe(0);
    expect(occasionIndexForDay(layout, utc(2026, 1, 5), 5)).toBe(0);
    expect(occasionIndexForDay(layout, utc(2026, 1, 6), 5)).toBe(1);
    expect(occasionIndexForDay(layout, utc(2026, 1, 12), 5)).toBe(2);
    expect(occasionIndexForDay(layout, utc(2025, 12, 31), 5)).toBeNull(); // before
    expect(occasionIndexForDay(layout, utc(2026, 1, 13), 5)).toBeNull(); // after
  });

  it("throws on an inverted window", () => {
    expect(() => computeOccasions(utc(2026, 1, 10), utc(2026, 1, 1), 5)).toThrow();
  });

  it("effortLevel distinguishes full vs ragged bins", () => {
    expect(effortLevel(5, 5)).toBe("full");
    expect(effortLevel(2, 5)).toBe("2d");
    expect(effortLevel(1, 5)).toBe("1d");
  });

  it("occasionEndDay clamps the ragged bin to the window end", () => {
    const layout = computeOccasions(utc(2026, 1, 1), utc(2026, 1, 12), 5);
    expect(occasionEndDay(layout, 2, 5)).toEqual(utc(2026, 1, 12));
  });
});

describe("standardize", () => {
  it("standardizes to mean 0 sd 1 and back-transforms exactly", () => {
    const vals = [1, 2, 3, 4, 5];
    const s = fitStandardization(vals);
    expect(s.mean).toBeCloseTo(3, 10);
    const z = standardizeArray(vals, s);
    expect(z.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 10);
    // round-trip
    for (const v of vals) {
      expect(backTransformValue(standardizeValue(v, s), s)).toBeCloseTo(v, 10);
    }
  });

  it("guards the constant-covariate case (sd 0 → sd 1, zeros out)", () => {
    const s = fitStandardization([7, 7, 7]);
    expect(s.sd).toBe(1);
    expect(standardizeValue(7, s)).toBe(0);
  });

  it("applies fitted params to a new grid (does not re-fit)", () => {
    const s = fitStandardization([0, 10]); // mean 5, sd 5
    expect(standardizeValue(5, s)).toBe(0);
    expect(standardizeValue(10, s)).toBe(1);
  });
});

describe("detection-history", () => {
  const sites: OccupancySite[] = [
    // 12-day window → 3 occasions [5,5,2]
    { siteId: "A", siteName: "A", latitude: 0, longitude: 0, windowStart: utc(2026, 1, 1), windowEnd: utc(2026, 1, 12) },
    // 10-day window → 2 occasions [5,5], NA-padded to 3
    { siteId: "B", siteName: "B", latitude: 0, longitude: 0, windowStart: utc(2026, 1, 1), windowEnd: utc(2026, 1, 10) },
    // surveyed, no detections
    { siteId: "C", siteName: "C", latitude: 0, longitude: 0, windowStart: utc(2026, 1, 1), windowEnd: utc(2026, 1, 10) },
  ];

  it("builds a 1/0/null matrix with NA padding for shorter windows", () => {
    const events: SpeciesDetectionEvent[] = [
      { siteId: "A", captureDay: utc(2026, 1, 2) }, // occ 0
      { siteId: "A", captureDay: utc(2026, 1, 11) }, // occ 2
      { siteId: "B", captureDay: utc(2026, 1, 7) }, // occ 1
    ];
    const frame = buildDetectionFrame(sites, events, { binWidth: 5 });
    expect(frame.maxOccasions).toBe(3);
    expect(frame.y[0]).toEqual([1, 0, 1]); // A
    expect(frame.y[1]).toEqual([0, 1, null]); // B: occ 2 is NA (window only 10 days)
    expect(frame.y[2]).toEqual([0, 0, null]); // C: surveyed, undetected
  });

  it("excludes out-of-window detections rather than folding them in", () => {
    const events: SpeciesDetectionEvent[] = [
      { siteId: "A", captureDay: utc(2025, 12, 20) }, // before window
      { siteId: "A", captureDay: utc(2026, 2, 1) }, // after window
      { siteId: "unknown", captureDay: utc(2026, 1, 2) }, // unknown site
    ];
    const frame = buildDetectionFrame(sites, events, { binWidth: 5 });
    expect(frame.totalDetections).toBe(0);
    expect(frame.y[0]).toEqual([0, 0, 0]);
    // discards are counted, not silently dropped
    expect(frame.nOutOfWindow).toBe(2); // the two A events outside the window
    expect(frame.nUnknownSite).toBe(1); // the "unknown" site event
  });

  it("computes naive occupancy and per-site rollups", () => {
    const events: SpeciesDetectionEvent[] = [
      { siteId: "A", captureDay: utc(2026, 1, 2) },
      { siteId: "B", captureDay: utc(2026, 1, 7) },
    ];
    const frame = buildDetectionFrame(sites, events, { binWidth: 5 });
    expect(frame.nSitesSurveyed).toBe(3);
    expect(frame.nSitesDetected).toBe(2);
    expect(frame.naiveOccupancy).toBeCloseTo(2 / 3, 10);
    expect(frame.perSite.find((p) => p.siteId === "C")!.detected).toBe(false);
  });

  it("labels effort per cell and null-pads it with NA cells", () => {
    const frame = buildDetectionFrame(sites, [], { binWidth: 5 });
    expect(frame.effort[0]).toEqual(["full", "full", "2d"]); // A ragged tail
    expect(frame.effort[1]).toEqual(["full", "full", null]); // B padded
  });

  it("exposes each site's sampling window so an outlier can be spotted", () => {
    const frame = buildDetectionFrame(sites, [], { binWidth: 5 });
    const a = frame.perSite.find((p) => p.siteId === "A")!;
    const b = frame.perSite.find((p) => p.siteId === "B")!;
    expect(a.windowStart).toEqual(utc(2026, 1, 1));
    expect(a.windowEnd).toEqual(utc(2026, 1, 12));
    expect(a.totalDays).toBe(12); // inclusive 12-day window
    expect(a.occasions).toBe(3);
    expect(b.totalDays).toBe(10);
    expect(b.occasions).toBe(2);
  });

  it("lets one long-window site inflate maxOccasions (the 74-occasion case)", () => {
    // A site spanning ~a year forces every row to that width via NA padding —
    // the diagnostic the matrix table surfaces.
    const longSites: OccupancySite[] = [
      ...sites,
      { siteId: "X", siteName: "X", latitude: 0, longitude: 0, windowStart: utc(2026, 1, 1), windowEnd: utc(2027, 1, 1) },
    ];
    const frame = buildDetectionFrame(longSites, [], { binWidth: 5 });
    const x = frame.perSite.find((p) => p.siteId === "X")!;
    expect(x.totalDays).toBe(366); // inclusive ~1-year window (2026 non-leap)
    expect(frame.maxOccasions).toBe(x.occasions); // X drives the matrix width
    expect(frame.maxOccasions).toBeGreaterThan(70);
  });
});

describe("eligibility", () => {
  const mkSites = (n: number): OccupancySite[] =>
    Array.from({ length: n }, (_, i) => ({
      siteId: `S${i}`,
      siteName: `S${i}`,
      latitude: 0,
      longitude: 0,
      windowStart: utc(2026, 1, 1),
      windowEnd: utc(2026, 1, 15),
    }));

  it("flags the current-DB reality (2 hotspot sites) as ineligible with reasons", () => {
    const sites = mkSites(2);
    const events: SpeciesDetectionEvent[] = Array.from({ length: 50 }, () => ({
      siteId: "S0",
      captureDay: utc(2026, 1, 3),
    }));
    const frame = buildDetectionFrame(sites, events, { binWidth: 5 });
    const res = assessEligibility(frame);
    expect(res.eligible).toBe(false);
    expect(res.reasons.length).toBeGreaterThan(0);
    expect(res.reasons.some((r) => r.includes("sitios"))).toBe(true);
  });

  it("passes when spread and counts clear the thresholds", () => {
    const sites = mkSites(20);
    // detect at 6 sites, once each in different occasions
    const events: SpeciesDetectionEvent[] = Array.from({ length: 12 }, (_, i) => ({
      siteId: `S${i % 6}`,
      captureDay: utc(2026, 1, 1 + (i % 10)),
    }));
    const frame = buildDetectionFrame(sites, events, { binWidth: 5 });
    const res = assessEligibility(frame, DEFAULT_THRESHOLDS);
    expect(res.stats.nSitesSurveyed).toBe(20);
    expect(res.stats.nSitesDetected).toBe(6);
    expect(res.eligible).toBe(true);
    expect(res.reasons).toEqual([]);
  });
});
