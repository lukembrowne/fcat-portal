import { describe, it, expect } from "vitest";
import * as scan from "../../scripts/biochoco-anomaly-scan.mjs";
import * as render from "../../scripts/render-anomaly-report.mjs";

// The scripts are plain .mjs (they must run in the prod container without a
// build), so their JSDoc-inferred types are loose — pin the shape here.
interface Finding {
  check: string;
  severity: string;
  evidence: { examples?: Array<{ imageId: number }>; swappedInstall?: string; suggestedShiftDays?: number; future?: number };
}
interface Result { stats: { outsideWindow: number | null; first: string | null }; findings: Finding[] }
const analyzeDeployment = scan.analyzeDeployment as unknown as (d: object, imgs: object[], o: { today: string }) => Result;
const swapDayMonth = scan.swapDayMonth as (d: string) => string | null;
const localStamp = scan.localStamp as (ms: number) => string;
const renderReport = render.renderReport as unknown as (s: object, o: { base: string }) => string;

const TODAY = "2026-11-09";
const H = 3600;

/** Unix seconds for an Ecuador-local wall-clock time (UTC-5). */
function ec(local: string): number {
  return Date.parse(`${local}:00Z`) / 1000 + 5 * H;
}

function hhmmss(sec: number): string {
  const d = new Date((sec - 5 * H) * 1000);
  return [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map((n) => String(n).padStart(2, "0")).join("");
}

/** n images spread evenly from `start` over `days` days, dateless-camera filenames. */
function spread(start: string, days: number, n: number, idBase = 1) {
  const s = ec(start);
  return Array.from({ length: n }, (_, i) => {
    const t = Math.round(s + (i * days * 86400) / Math.max(1, n - 1));
    return { id: idBase + i, filename: `${hhmmss(t)}_${1000 + i}.jpg`, exifTimestamp: null, fileModified: t };
  });
}

function dep(over: Record<string, unknown> = {}) {
  return { id: 1, name: "TST-001_V1", dateStart: "2026-08-11", dateEnd: "2026-09-11", validStart: null, validEnd: null, ...over };
}

const checks = (r: Result) => r.findings.map((f) => f.check);

describe("biochoco anomaly scan", () => {
  it("passes a healthy deployment", () => {
    const r = analyzeDeployment(dep(), spread("2026-08-11T10:00", 31, 60), { today: TODAY });
    expect(r.findings).toEqual([]);
    expect(r.stats.outsideWindow).toBe(0);
  });

  it("flags a clock that never advanced (CCN-012_V2 shape)", () => {
    const t = ec("2026-08-23T08:16");
    const imgs = Array.from({ length: 306 }, (_, i) => ({ id: i + 1, filename: `081618_${i}.jpg`, exifTimestamp: null, fileModified: t + (i % 10) * 2 }));
    const r = analyzeDeployment(dep({ dateStart: "2026-08-23", dateEnd: "2026-09-23" }), imgs, { today: TODAY });
    expect(checks(r)).toContain("timestamps_collapsed");
    expect(r.findings[0].severity).toBe("error");
  });

  it("detects a day/month swap (POT-012_V1 shape) and suggests the shift", () => {
    const r = analyzeDeployment(dep(), spread("2026-11-08T14:54", 31, 49), { today: TODAY });
    const f = r.findings.find((x) => x.check === "date_day_month_swapped");
    expect(f).toBeDefined();
    expect(f?.evidence.swappedInstall).toBe("2026-11-08");
    expect(f?.evidence.suggestedShiftDays).toBe(-89);
    expect(f?.evidence.future).toBeGreaterThan(0);
    // A swap already explains the future dates — no separate future finding.
    expect(checks(r)).not.toContain("future_timestamps");
  });

  it("reports both collapse and swap together (PRI-008_V2 shape)", () => {
    const t = ec("2026-12-08T10:15");
    const imgs = Array.from({ length: 65 }, (_, i) => ({ id: i + 1, filename: `101500_${i}.jpg`, exifTimestamp: null, fileModified: t }));
    const r = analyzeDeployment(dep({ dateStart: "2026-08-12", dateEnd: "2026-09-12" }), imgs, { today: TODAY });
    expect(checks(r)).toEqual(expect.arrayContaining(["timestamps_collapsed", "date_day_month_swapped"]));
  });

  it("classifies a whole-year shift and a factory reset", () => {
    const year = analyzeDeployment(dep(), spread("2025-08-11T10:00", 31, 30), { today: TODAY });
    expect(checks(year)).toContain("clock_wrong_year");
    const reset = analyzeDeployment(dep(), spread("2016-01-01T00:00", 31, 30), { today: TODAY });
    expect(checks(reset)).toContain("clock_reset");
  });

  it("does not call a swap when the day is > 12", () => {
    expect(swapDayMonth("2026-08-23")).toBeNull();
    expect(swapDayMonth("2026-08-08")).toBeNull();
    expect(swapDayMonth("2026-08-11")).toBe("2026-11-08");
  });

  it("lists a single stray image as an outlier (NAC-003_V1 shape)", () => {
    const imgs = spread("2026-04-21T10:00", 30, 50);
    imgs.push({ id: 999, filename: "101400_9999.jpg", exifTimestamp: null, fileModified: ec("2024-04-21T10:14") });
    const r = analyzeDeployment(dep({ dateStart: "2026-04-21", dateEnd: "2026-05-21" }), imgs, { today: TODAY });
    const f = r.findings.find((x) => x.check === "outlier_timestamps");
    expect(f?.severity).toBe("warn");
    expect(f?.evidence.examples?.[0].imageId).toBe(999);
  });

  it("flags late start and early stop as coverage, not clock errors", () => {
    const r = analyzeDeployment(dep(), spread("2026-08-20T10:00", 10, 40), { today: TODAY });
    expect(checks(r)).toEqual(["late_start", "early_stop"]);
  });

  it("flags a filename time that disagrees with the stored time", () => {
    const imgs = spread("2026-08-11T10:00", 31, 20);
    imgs[5] = { ...imgs[5], filename: "030000_0005.jpg" };
    const r = analyzeDeployment(dep(), imgs, { today: TODAY });
    expect(checks(r)).toContain("filename_time_mismatch");
  });

  it("prefers EXIF over file_modified and reports local Ecuador time regardless of TZ", () => {
    const imgs = [{ id: 1, filename: "a.jpg", exifTimestamp: "2026-08-11T15:00:00.000Z", fileModified: ec("2020-01-01T00:00") }];
    const r = analyzeDeployment(dep(), imgs, { today: TODAY });
    expect(r.stats.first).toBe("2026-08-11 10:00");
    expect(localStamp(Date.parse("2026-08-11T15:00:00Z"))).toBe("2026-08-11 10:00");
  });

  it("renders links to the deployment and to each example image", () => {
    const r = analyzeDeployment(dep({ id: 535, name: "POT-012_V1" }), spread("2026-11-08T14:54", 31, 49, 100), { today: TODAY });
    const snapshot = {
      today: TODAY, project: "BioChoco",
      totals: { deployments: 1, withImages: 1, flagged: 1, flaggedExcluded: 0, bySeverity: { error: 1, warn: 0, info: 0 }, byCheck: {} },
      deployments: [{ id: 535, name: "POT-012_V1", status: "verified", excludedCamera: false, severity: "error", stats: r.stats, findings: r.findings }],
    };
    const html = renderReport(snapshot, { base: "https://portal.example" });
    expect(html).toContain('href="https://portal.example/camera-trap/535"');
    expect(html).toContain("https://portal.example/camera-trap/535/preview/100");
    expect(html).not.toMatch(/<!doctype/i);
  });
});

describe("small single-burst deployments", () => {
  it("calls 3 install-time photos a dead camera, not a stuck clock (POT-013_V1 shape)", () => {
    const t = ec("2026-03-19T10:20");
    const imgs = [0, 5, 9].map((s, i) => ({ id: i + 1, filename: `1020${String(s).padStart(2, "0")}_${i}.jpg`, exifTimestamp: null, fileModified: t + s }));
    const r = analyzeDeployment({ id: 1, name: "X", dateStart: "2026-03-19", dateEnd: "2026-04-19", validStart: null, validEnd: null }, imgs, { today: "2026-11-09" });
    expect(r.findings.map((f) => f.check)).toEqual(["setup_burst_only"]);
  });
});

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

interface AudioResult {
  stats: { scheduleMinutes: number | null; clock: { lag: number } | null; before?: number; after?: number };
  findings: Array<{ check: string; severity: string; detail: string; evidence: Record<string, unknown> }>;
}
type AudioFile = { id: number; filename: string; fileSize: number };
const analyzeAudio = scan.analyzeAudioDeployment as unknown as (
  d: object, f: AudioFile[], o: { today: string; hourCounts?: number[]; referenceProfile?: number[] },
) => AudioResult;
const parseAudioName = scan.parseAudioName as (f: string) => { serial: string; ms: number } | null;
const clockLag = scan.clockLag as (h: number[], r: number[]) => { lag: number; best: number; atZero: number };
const analyzeReadiness = scan.analyzeReadiness as unknown as (
  facts: object[], o: { today: string },
) => { deployments: Array<{ name: string; findings: Array<{ check: string; severity: string; detail: string; title: string; evidence: Record<string, unknown> }> }> };

/** Ecuador wall clock "YYYY-MM-DDTHH:MM" → recorder filename. */
function audioName(serial: string, sec: number, ext = "wav") {
  const d = new Date((sec - 5 * H) * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${serial}_${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}.${ext}`;
}

/** One recording every `stepMin` minutes from `start` for `days` days. */
function recordings(start: string, days: number, stepMin = 10, serial = "2MM00001", idBase = 1): AudioFile[] {
  const s = ec(start);
  const n = Math.floor((days * 1440) / stepMin);
  return Array.from({ length: n }, (_, i) => ({ id: idBase + i, filename: audioName(serial, s + i * stepMin * 60), fileSize: 5_000_000 }));
}

const aChecks = (r: AudioResult) => r.findings.map((f) => f.check);

/** Dawn-peaked profile like BioChoco's: high 06–09, near-zero at night. */
const DAWN = Array.from({ length: 24 }, (_, h) => (h >= 6 && h <= 9 ? 90 : h >= 10 && h <= 17 ? 30 : 7));

describe("audio anomaly scan", () => {
  it("parses recorder filenames as Ecuador wall clock, independent of TZ", () => {
    const p = parseAudioName("2MM20627_20260212_143000.wav");
    expect(p?.serial).toBe("2MM20627");
    expect(localStamp(p!.ms)).toBe("2026-02-12 14:30");
    expect(new Date(p!.ms).toISOString()).toBe("2026-02-12T19:30:00.000Z");
    expect(parseAudioName("2MM20627_20260231_143000.flac")).toBeNull();
  });

  it("passes a healthy deployment and records the schedule", () => {
    const r = analyzeAudio(dep(), recordings("2026-08-11T12:00", 31), { today: TODAY });
    expect(r.findings).toEqual([]);
    expect(r.stats.scheduleMinutes).toBe(10);
  });

  it("warns on pre-install test recordings", () => {
    const files = [...recordings("2026-08-11T12:00", 31), { id: 9000, filename: audioName("2MM00001", ec("2026-08-05T09:00")), fileSize: 5e6 }];
    const r = analyzeAudio(dep(), files, { today: TODAY });
    const f = r.findings.find((x) => x.check === "audio_before_install");
    expect(f?.severity).toBe("warn");
    expect(f?.detail).toContain("05/08/2026 09:00");
  });

  it("errors when ≥10% of files fall after retrieval (POT-001_V1 shape), warns below", () => {
    const big = analyzeAudio(dep(), recordings("2026-08-11T12:00", 45), { today: TODAY });
    expect(big.findings.find((x) => x.check === "audio_after_retrieval")?.severity).toBe("error");
    const small = analyzeAudio(dep(), recordings("2026-08-11T12:00", 33.5), { today: TODAY });
    expect(small.findings.find((x) => x.check === "audio_after_retrieval")?.severity).toBe("warn");
  });

  it("errors on a second recorder serial and lists the minority files", () => {
    const files = [...recordings("2026-08-11T12:00", 31), ...recordings("2026-08-20T12:00", 1, 60, "2MM99999", 5000)];
    const f = analyzeAudio(dep(), files, { today: TODAY }).findings.find((x) => x.check === "audio_mixed_recorders");
    expect(f?.severity).toBe("error");
    expect((f?.evidence.examples as Array<{ filename: string }>)[0].filename).toMatch(/^2MM99999_/);
  });

  it("warns on a >24 h gap (NAC-004_V1 shape)", () => {
    const files = [...recordings("2026-08-11T12:00", 5), ...recordings("2026-08-29T12:00", 13, 10, "2MM00001", 50_000)];
    const f = analyzeAudio(dep(), files, { today: TODAY }).findings.find((x) => x.check === "audio_gap");
    expect(f?.severity).toBe("warn");
    expect(f?.detail).toContain("16/08/2026");
  });

  it("errors when the recorder died in the first two days of a long deployment", () => {
    const r = analyzeAudio(dep(), recordings("2026-08-11T12:00", 1.2), { today: TODAY });
    expect(aChecks(r)).toEqual(["audio_died_early"]);
    expect(r.findings[0].severity).toBe("error");
  });

  it("reports an early stop as info", () => {
    const r = analyzeAudio(dep(), recordings("2026-08-11T12:00", 20), { today: TODAY });
    expect(aChecks(r)).toEqual(["audio_early_stop"]);
  });

  it("warns on duplicate filenames and tiny files", () => {
    const files = recordings("2026-08-11T12:00", 31);
    files.push({ ...files[10], id: 7000 });
    files[20] = { ...files[20], fileSize: 4096 };
    const r = analyzeAudio(dep(), files, { today: TODAY });
    expect(aChecks(r)).toEqual(expect.arrayContaining(["audio_duplicate_files", "audio_tiny_files"]));
  });

  it("detects a clock in another zone from the dawn chorus (CCN-015_V1 shape)", () => {
    expect(clockLag(DAWN, DAWN).lag).toBe(0);
    // UTC-set recorder: labels read 5 h late → dawn peak at 11–14.
    const utc = DAWN.map((_, h) => DAWN[(h - 5 + 24) % 24]);
    const r = analyzeAudio(dep(), recordings("2026-08-11T12:00", 31), { today: TODAY, hourCounts: utc, referenceProfile: DAWN });
    const f = r.findings.find((x) => x.check === "audio_clock_zone");
    expect(f?.severity).toBe("warn");
    expect(r.stats.clock?.lag).toBe(5);
    // A profile that matches at lag 0 says nothing.
    const ok = analyzeAudio(dep(), recordings("2026-08-11T12:00", 31), { today: TODAY, hourCounts: DAWN, referenceProfile: DAWN });
    expect(ok.findings).toEqual([]);
  });

  it("stays silent on the clock below the identification floor", () => {
    const tiny = DAWN.map((_, h) => (h === 13 ? 50 : 1));
    const r = analyzeAudio(dep(), recordings("2026-08-11T12:00", 31), { today: TODAY, hourCounts: tiny, referenceProfile: DAWN });
    expect(r.stats.clock).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Occupancy readiness
// ---------------------------------------------------------------------------

function fact(over: Record<string, unknown> = {}) {
  return {
    id: 1, name: "TST-001_V1", status: "verified", latitude: 0.9, longitude: -79.6,
    dateStart: "2026-08-11", dateEnd: "2026-09-11", validStart: null, validEnd: null,
    excludedCamera: false, excludedAudio: false, hasCamera: true, hasAudio: false,
    cameraChecks: [], lastImageDay: "2026-09-11", lastAudioDay: null,
    uploadCameraCount: 300, videoCount: 0, mlProcessed: 300, dbImages: 300, blanksDeleted: 0,
    identifications: 100, unverifiedIdentifications: 0,
    ...over,
  };
}
const ready = (facts: object[]) => analyzeReadiness(facts, { today: TODAY }).deployments;
const rChecks = (facts: object[]) => ready(facts).flatMap((d) => d.findings.map((f) => f.check));

describe("occupancy readiness", () => {
  // A spread of well-separated sites keeps the median bbox meaningful.
  const others = [1, 2, 3, 4].map((i) => fact({ id: 100 + i, name: `OTH-00${i}_V1`, latitude: 0.9 + i * 0.02, longitude: -79.6 - i * 0.02 }));

  it("passes healthy sites", () => {
    expect(rChecks([fact(), ...others])).toEqual([]);
  });

  it("errors when a camera stopped early and there is no valid_end", () => {
    expect(rChecks([fact({ cameraChecks: ["early_stop"], lastImageDay: "2026-08-20" }), ...others])).toEqual(["ready_dead_days_counted"]);
    expect(rChecks([fact({ cameraChecks: ["early_stop"], validEnd: "2026-08-20 10:00" }), ...others])).toEqual([]);
  });

  it("errors on incomplete ML coverage, infos on post-processing blank deletion", () => {
    expect(rChecks([fact({ mlProcessed: 153, dbImages: 153, uploadCameraCount: 298 }), ...others])).toEqual(["ready_incomplete_processing"]);
    const del = rChecks([fact({ mlProcessed: 300, dbImages: 34, blanksDeleted: 266 }), ...others]);
    expect(del).toEqual(["ready_blanks_deleted"]);
    // Videos are not images the model was supposed to see.
    expect(rChecks([fact({ uploadCameraCount: 40, videoCount: 40, mlProcessed: 0 }), ...others])).toEqual([]);
  });

  it("warns on different sites <500 m apart that overlapped, with distance and no coordinates", () => {
    const a = fact({ id: 1, name: "CCN-003_V1" });
    const b = fact({ id: 2, name: "NAC-005_V1", latitude: 0.9005, longitude: -79.6 });
    const out = ready([a, b, ...others]);
    const f = out.flatMap((d) => d.findings).find((x) => x.check === "ready_sites_too_close");
    expect(f?.severity).toBe("warn");
    expect(f?.evidence.distanceM).toBe(56);
    expect(JSON.stringify(out)).not.toMatch(/0\.900|79\.6/);
    // Same site code (V1 vs V2) is a revisit, not a pair; no overlap → no pair.
    expect(rChecks([a, fact({ id: 3, name: "CCN-003_V2", latitude: 0.9005 }), ...others])).toEqual([]);
    expect(rChecks([a, fact({ id: 4, name: "NAC-005_V1", latitude: 0.9005, dateStart: "2026-10-01", dateEnd: "2026-11-01" }), ...others])).toEqual([]);
  });

  it("counts 150–500 m overlapping pairs as design spacing instead of flagging them", () => {
    const a = fact({ id: 1, name: "CCN-005_V1" });
    const b = fact({ id: 2, name: "POT-008_V1", latitude: 0.9018, longitude: -79.6 }); // ~200 m
    const out = analyzeReadiness([a, b, ...others], { today: TODAY }) as unknown as { deployments: unknown[]; designPairs: number };
    expect(out.deployments).toEqual([]);
    expect(out.designPairs).toBe(1);
  });

  it("errors when the same deployment name is registered twice (NAC-014_V1 shape)", () => {
    const out = ready([fact({ id: 513, name: "NAC-014_V1", hasCamera: false, hasAudio: true, audioFiles: 491 }), fact({ id: 517, name: "NAC-014_V1", hasAudio: true, audioFiles: 491 }), ...others]);
    const checksOut = out.flatMap((d) => d.findings.map((f) => f.check));
    expect(checksOut).toEqual(["ready_duplicate_deployment"]);
    expect(out[0].findings[0].severity).toBe("error");
    // One empty orphan row: nothing counted twice → warn.
    const orphan = ready([fact({ id: 490, name: "POT-015_V1", hasCamera: false }), fact({ id: 536, name: "POT-015_V1" }), ...others]);
    expect(orphan[0].findings[0].severity).toBe("warn");
  });

  it("errors on missing or implausible coordinates; warns on identical coordinates across sites", () => {
    expect(rChecks([fact({ latitude: null }), ...others])).toEqual(["ready_missing_coordinates"]);
    expect(rChecks([fact({ latitude: -0.9 }), ...others])).toEqual(["ready_implausible_coordinates"]);
    const twins = rChecks([fact({ dateStart: "2025-01-01", dateEnd: "2025-02-01" }), fact({ id: 2, name: "ZZZ-001_V1" }), ...others]);
    expect(twins).toEqual(["ready_identical_coordinates"]);
  });

  it("warns when the recorder ran on well past the camera and the retrieval", () => {
    const f = fact({ hasAudio: true, lastImageDay: "2026-09-11", lastAudioDay: "2026-09-25" });
    expect(rChecks([f, ...others])).toEqual(["ready_sensor_dates_disagree"]);
    // Within the retrieval window: camera died early, recorder fine — not a disagreement.
    expect(rChecks([fact({ hasAudio: true, lastImageDay: "2026-08-30", lastAudioDay: "2026-09-11", validEnd: "x", cameraChecks: [] }), ...others])).toEqual([]);
  });

  it("infos when most identifications on a verified deployment are unverified", () => {
    expect(rChecks([fact({ identifications: 100, unverifiedIdentifications: 60 }), ...others])).toEqual(["ready_unverified"]);
  });
});

describe("report rendering — audio and readiness", () => {
  it("links audio cards to the audio page and readiness pairs to the other site", () => {
    const a = analyzeAudio(dep({ id: 498 }), recordings("2026-08-11T12:00", 45), { today: TODAY });
    const snapshot = {
      today: TODAY, project: "BioChoco",
      totals: { deployments: 1, withImages: 0, flagged: 0, flaggedExcluded: 0, bySeverity: { error: 0, warn: 0, info: 0 }, byCheck: {} },
      deployments: [],
      audio: {
        totals: { withAudio: 1, flagged: 1, flaggedExcluded: 0, excluded: [], scheduleMinutes: { 10: 1 }, bySeverity: { error: 1, warn: 0, info: 0 }, byCheck: {} },
        deployments: [{ id: 498, name: "POT-001_V1", status: "verified", excludedAudio: false, severity: "error", stats: a.stats, findings: a.findings }],
      },
      readiness: {
        totals: { flagged: 1, designPairs: 3, nearSiteM: 150, designSpacingM: 500, bySeverity: { error: 0, warn: 1, info: 0 }, byCheck: {} },
        deployments: [{ id: 544, name: "CCN-012_V2", status: "verified", severity: "warn", findings: [{ check: "ready_sites_too_close", severity: "warn", title: "t", detail: "d", action: "a", evidence: { otherId: 545, otherName: "NAC-008_V2", distanceM: 123, overlapDays: 29 } }] }],
      },
    };
    const html = renderReport(snapshot, { base: "https://portal.example" });
    expect(html).toContain('href="https://portal.example/audio/498"');
    expect(html).toContain('href="https://portal.example/camera-trap/545"');
    expect(html).toContain('id="ocupacion"');
    expect(html).toContain("cada 10 min en 1 despliegues");
  });
});
