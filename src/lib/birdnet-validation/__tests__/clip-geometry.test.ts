import { describe, it, expect } from "vitest";

import {
  clipWindow,
  detectionBand,
  measuredBand,
  recordingInstant,
  CLIP_PADDING_SECONDS,
} from "../clip-geometry";

describe("detectionBand", () => {
  const band = (startTime: number, endTime: number, duration: number | null) =>
    detectionBand(clipWindow({ startTime, endTime, duration }), { startTime, endTime });

  it("centres a mid-file detection in a full window", () => {
    // 3s detection padded by 3s each side = 9s clip; the call is the middle third.
    const { leftPct, rightPct } = band(20, 23, 60);
    expect(leftPct).toBeCloseTo(33.333, 2);
    expect(rightPct).toBeCloseTo(66.667, 2);
  });

  it("shifts the band left when the window clamps at the file start", () => {
    // The specific case a hardcoded 33-67% gets wrong: only 0.5s of padding is
    // available before the detection, so it sits earlier in a shorter clip.
    const { leftPct, rightPct } = band(0.5, 3.5, 60);
    expect(leftPct).toBeCloseTo((0.5 / 6.5) * 100, 2);
    expect(rightPct).toBeCloseTo((3.5 / 6.5) * 100, 2);
    expect(leftPct).not.toBeCloseTo(33.333, 1);
  });

  it("shifts the band right when the window clamps at the file end", () => {
    const { leftPct, rightPct } = band(56, 59.5, 60);
    const win = clipWindow({ startTime: 56, endTime: 59.5, duration: 60 });
    const span = win.end - win.start;
    expect(leftPct).toBeCloseTo(((56 - win.start) / span) * 100, 2);
    expect(rightPct).toBeCloseTo(((59.5 - win.start) / span) * 100, 2);
    expect(rightPct).toBeGreaterThan(66.667);
  });

  it("leaves the right edge unclamped when the duration is unknown", () => {
    // Correct FOR ITS INPUTS, and wrong on screen: `audio_files.duration` is
    // NULL on essentially every row, so this is the production path and the
    // clip comes back shorter than the window says. `measuredBand` is what
    // closes that gap; this stays only to pin the fallback's shape.
    const { leftPct, rightPct } = band(56, 59.5, null);
    expect(Number.isNaN(leftPct)).toBe(false);
    expect(Number.isNaN(rightPct)).toBe(false);
    expect(rightPct).toBeGreaterThan(leftPct);
  });

  it("keeps both edges within 0-100 across every case", () => {
    const cases: Array<[number, number, number | null]> = [
      [20, 23, 60],
      [0.5, 3.5, 60],
      [0, 3, 60],
      [56, 59.5, 60],
      [57, 60, 60],
      [56, 59.5, null],
      [10, 13, 0],
      [30, 10, 60],
    ];
    for (const [start, end, duration] of cases) {
      const { leftPct, rightPct } = band(start, end, duration);
      expect(leftPct, `left for ${start}-${end}/${duration}`).toBeGreaterThanOrEqual(0);
      expect(leftPct).toBeLessThanOrEqual(100);
      expect(rightPct).toBeGreaterThanOrEqual(0);
      expect(rightPct).toBeLessThanOrEqual(100);
    }
  });

  it("always produces a visible band, even for degenerate bounds", () => {
    // `clipWindow` falls back to a 1s window when the detection bounds are
    // inverted; the band must still have width or the marker disappears.
    const { leftPct, rightPct } = band(30, 10, 60);
    expect(rightPct).toBeGreaterThan(leftPct);
  });

  it("covers the whole width when the window has no span", () => {
    expect(detectionBand({ start: 5, end: 5 }, { startTime: 5, endTime: 8 })).toEqual({
      leftPct: 0,
      rightPct: 100,
    });
  });

  it("uses the documented padding", () => {
    expect(CLIP_PADDING_SECONDS).toBe(3);
  });
});

describe("recordingInstant", () => {
  const FILE = "2MM21842_20260210_145000.flac";

  it("reads the filename timestamp at offset zero", () => {
    expect(recordingInstant(FILE, 0)).toBe("2026-02-10 14:50:00");
  });

  it("adds the detection offset", () => {
    expect(recordingInstant(FILE, 30)).toBe("2026-02-10 14:50:30");
  });

  it("rolls over a minute boundary", () => {
    expect(recordingInstant(FILE, 70)).toBe("2026-02-10 14:51:10");
  });

  it("rolls over an hour boundary", () => {
    expect(recordingInstant("X_20260210_145900.wav", 120)).toBe("2026-02-10 15:01:00");
  });

  it("rolls over midnight into the next day", () => {
    expect(recordingInstant("X_20260210_235930.wav", 60)).toBe("2026-02-11 00:00:30");
  });

  it("rolls over a month boundary", () => {
    expect(recordingInstant("X_20260228_235930.wav", 60)).toBe("2026-03-01 00:00:30");
  });

  it("rounds a fractional offset to the nearest second", () => {
    expect(recordingInstant(FILE, 30.4)).toBe("2026-02-10 14:50:30");
    expect(recordingInstant(FILE, 30.6)).toBe("2026-02-10 14:50:31");
  });

  it("returns null for a filename with no timestamp", () => {
    // The caller renders nothing rather than "Invalid Date".
    expect(recordingInstant("recording.wav", 0)).toBeNull();
    expect(recordingInstant("", 0)).toBeNull();
    expect(recordingInstant(null, 0)).toBeNull();
    expect(recordingInstant(undefined, 0)).toBeNull();
  });

  it("handles both .wav and .flac", () => {
    expect(recordingInstant("A_20260210_145000.wav", 0)).toBe("2026-02-10 14:50:00");
    expect(recordingInstant("A_20260210_145000.flac", 0)).toBe("2026-02-10 14:50:00");
  });

  it("gives the same answer regardless of the host timezone", () => {
    // Audio filenames carry Ecuador local wall-clock with no offset. Composing
    // through a local-timezone Date would shift every timestamp by the host's
    // offset — invisible on a laptop in Ecuador, five hours wrong in a UTC
    // container.
    const original = process.env.TZ;
    const results: string[] = [];
    for (const tz of ["UTC", "America/Guayaquil", "Asia/Tokyo", "Pacific/Auckland"]) {
      process.env.TZ = tz;
      results.push(recordingInstant(FILE, 45)!);
    }
    process.env.TZ = original;

    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe("2026-02-10 14:50:45");
  });
});

describe("measuredBand", () => {
  it("positions the detection against the clip that actually arrived", () => {
    // BirdNET's last window on a 60s recording. The requested window is
    // [55, 63] = 8s; ffmpeg returns 5s, because the file ends at 60.
    const win = clipWindow({ startTime: 58, endTime: 60, duration: null });
    expect(win).toEqual({ start: 55, end: 63 });

    const estimate = detectionBand(win, { startTime: 58, endTime: 60 });
    expect(estimate.leftPct).toBeCloseTo(37.5, 3);
    expect(estimate.rightPct).toBeCloseTo(62.5, 3);

    // Measured against the 5s that arrived, the detection is the LAST 40%.
    const actual = measuredBand(win.start, { startTime: 58, endTime: 60 }, 5);
    expect(actual).not.toBeNull();
    expect(actual!.leftPct).toBeCloseTo(60, 3);
    expect(actual!.rightPct).toBeCloseTo(100, 3);
  });

  it("corrects the 56s window too, where the band was only half wrong", () => {
    // [53, 62] requested, 7s delivered. The estimate's band overlaps the truth,
    // which is why this case read as "close enough" rather than as a bug.
    const win = clipWindow({ startTime: 56, endTime: 59, duration: null });
    const actual = measuredBand(win.start, { startTime: 56, endTime: 59 }, 7);
    expect(actual!.leftPct).toBeCloseTo((3 / 7) * 100, 3);
    expect(actual!.rightPct).toBeCloseTo((6 / 7) * 100, 3);
  });

  it("agrees with the estimate when the clip came back the length asked for", () => {
    const win = clipWindow({ startTime: 20, endTime: 23, duration: null });
    const estimate = detectionBand(win, { startTime: 20, endTime: 23 });
    const actual = measuredBand(win.start, { startTime: 20, endTime: 23 }, 9);
    expect(actual!.leftPct).toBeCloseTo(estimate.leftPct, 6);
    expect(actual!.rightPct).toBeCloseTo(estimate.rightPct, 6);
  });

  it("handles a clip clamped at the start of the recording", () => {
    // start_time 0: the window needs no end clamp, so this path was always
    // right and must stay right.
    const win = clipWindow({ startTime: 0, endTime: 3, duration: null });
    const actual = measuredBand(win.start, { startTime: 0, endTime: 3 }, 6);
    expect(actual!.leftPct).toBeCloseTo(0, 3);
    expect(actual!.rightPct).toBeCloseTo(50, 3);
  });

  it("returns null for a duration the browser has not reported yet", () => {
    const detection = { startTime: 58, endTime: 60 };
    expect(measuredBand(55, detection, null)).toBeNull();
    expect(measuredBand(55, detection, undefined)).toBeNull();
    // `audio.duration` is NaN before metadata and 0 on a failed load.
    expect(measuredBand(55, detection, Number.NaN)).toBeNull();
    expect(measuredBand(55, detection, 0)).toBeNull();
    expect(measuredBand(55, detection, Number.POSITIVE_INFINITY)).toBeNull();
    expect(measuredBand(55, detection, -1)).toBeNull();
  });

  it("keeps both edges inside 0-100 when the clip is shorter than the detection", () => {
    const band = measuredBand(55, { startTime: 58, endTime: 60 }, 1)!;
    expect(band.leftPct).toBeGreaterThanOrEqual(0);
    expect(band.rightPct).toBeLessThanOrEqual(100);
    expect(band.rightPct).toBeGreaterThan(band.leftPct);
  });
});
