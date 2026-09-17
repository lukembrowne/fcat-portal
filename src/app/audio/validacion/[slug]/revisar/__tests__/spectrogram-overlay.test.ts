import { describe, it, expect } from "vitest";

import {
  bandScrims,
  centeredScrollLeft,
  formatClipSeconds,
  playheadPercent,
} from "../spectrogram-overlay";

describe("playheadPercent", () => {
  it("maps playback position across the clip", () => {
    expect(playheadPercent(0, 9)).toBe(0);
    expect(playheadPercent(4.5, 9)).toBe(50);
    expect(playheadPercent(9, 9)).toBe(100);
  });

  it("returns 0 before metadata provides a duration", () => {
    // Every clip renders in this state on its first frame, so NaN or Infinity
    // here would be visible on every advance rather than in an edge case.
    expect(playheadPercent(0, NaN)).toBe(0);
    expect(playheadPercent(1, NaN)).toBe(0);
    expect(playheadPercent(1, 0)).toBe(0);
    expect(playheadPercent(1, null)).toBe(0);
    expect(playheadPercent(1, undefined)).toBe(0);
    expect(playheadPercent(1, Infinity)).toBe(0);
  });

  it("clamps to 100 when currentTime runs past duration", () => {
    // AAC priming padding can leave currentTime marginally beyond duration.
    expect(playheadPercent(9.4, 9)).toBe(100);
    expect(playheadPercent(1000, 9)).toBe(100);
  });

  it("never returns a negative position", () => {
    expect(playheadPercent(-1, 9)).toBe(0);
  });

  it("treats any non-finite currentTime as not-started", () => {
    // A broken reading resets the line to the left edge rather than pinning it
    // at the right — 0 is the recoverable state, 100 looks like "finished".
    expect(playheadPercent(NaN, 9)).toBe(0);
    expect(playheadPercent(Infinity, 9)).toBe(0);
    expect(playheadPercent(-Infinity, 9)).toBe(0);
  });

  it("is proportional across a clamped, shorter clip", () => {
    // A clip clamped at the file start is 6.5s, not 9s; the playhead is a pure
    // fraction of the decoded duration, so it needs no knowledge of the clamp.
    expect(playheadPercent(3.25, 6.5)).toBe(50);
  });
});

describe("bandScrims", () => {
  it("dims both sides of a detection in the middle of the clip", () => {
    expect(bandScrims(30, 70)).toEqual([
      { leftPct: 0, widthPct: 30 },
      { leftPct: 70, widthPct: 30 },
    ]);
  });

  it("omits the left scrim when the detection starts at the clip start", () => {
    // Real: `clipWindow` clamps against the file start, so the detection is not
    // always centred. A zero-width div still paints, so it must not be emitted.
    expect(bandScrims(0, 40)).toEqual([{ leftPct: 40, widthPct: 60 }]);
  });

  it("omits the right scrim when the detection runs to the clip end", () => {
    expect(bandScrims(60, 100)).toEqual([{ leftPct: 0, widthPct: 60 }]);
  });

  it("emits nothing when the detection spans the whole clip", () => {
    expect(bandScrims(0, 100)).toEqual([]);
  });

  it("orders inverted bounds rather than producing a negative width", () => {
    expect(bandScrims(70, 30)).toEqual([
      { leftPct: 0, widthPct: 30 },
      { leftPct: 70, widthPct: 30 },
    ]);
  });

  it("clamps out-of-range percentages into the image", () => {
    const scrims = bandScrims(-20, 130);
    expect(scrims).toEqual([]);
    for (const s of bandScrims(-20, 50)) {
      expect(s.leftPct).toBeGreaterThanOrEqual(0);
      expect(s.leftPct + s.widthPct).toBeLessThanOrEqual(100);
    }
  });

  it("never emits a zero or negative width", () => {
    const cases: Array<[number, number]> = [
      [0, 0],
      [100, 100],
      [50, 50],
      [0, 100],
      [12.5, 87.5],
    ];
    for (const [lo, hi] of cases) {
      for (const s of bandScrims(lo, hi)) {
        expect(s.widthPct, `scrim for ${lo}-${hi}`).toBeGreaterThan(0);
      }
    }
  });
});

/**
 * Scroll tracking for a zoomed clip.
 *
 * Zoom was close to useless before this: playback ran off the right-hand edge
 * within a second or two and left the reviewer looking at a still image of
 * audio that had already gone past, and changing zoom reset the view to second
 * 0 with the detection several screens away.
 */
describe("centeredScrollLeft", () => {
  it("returns null when the clip already fits, so callers can leave scroll alone", () => {
    expect(centeredScrollLeft(50, 600, 600)).toBeNull();
    expect(centeredScrollLeft(50, 400, 600)).toBeNull();
  });

  it("centres the point in the viewport", () => {
    // 50% of 4800 = 2400, minus half a 1200-wide viewport.
    expect(centeredScrollLeft(50, 4800, 1200)).toBe(1800);
  });

  it("holds still through the first half-screen instead of scrolling negative", () => {
    expect(centeredScrollLeft(0, 4800, 1200)).toBe(0);
    expect(centeredScrollLeft(10, 4800, 1200)).toBe(0);
  });

  it("holds still through the last half-screen instead of overscrolling", () => {
    const overflow = 4800 - 1200;
    expect(centeredScrollLeft(100, 4800, 1200)).toBe(overflow);
    expect(centeredScrollLeft(95, 4800, 1200)).toBe(overflow);
  });

  it("lands on an off-centre detection, not on the clip's midpoint", () => {
    // A clip clamped against the start of its recording: the band sits early.
    // 6.8% of sampled clips are shaped like this.
    const early = centeredScrollLeft((0 + 33) / 2, 4800, 1200);
    const centred = centeredScrollLeft((33.3 + 66.7) / 2, 4800, 1200);
    expect(early).toBeLessThan(centred!);
  });
});

describe("formatClipSeconds", () => {
  it("renders one decimal, matching the confidence readout's dot", () => {
    expect(formatClipSeconds(5)).toBe("5.0 s");
    expect(formatClipSeconds(8.976)).toBe("9.0 s");
    expect(formatClipSeconds(6.04)).toBe("6.0 s");
  });

  it("renders nothing before the duration is known", () => {
    // The pre-metadata state on every advance: a readout must be absent, not
    // "NaN s" in the corner of the picture the reviewer is judging.
    expect(formatClipSeconds(null)).toBeNull();
    expect(formatClipSeconds(undefined)).toBeNull();
    expect(formatClipSeconds(NaN)).toBeNull();
    expect(formatClipSeconds(0)).toBeNull();
    expect(formatClipSeconds(Infinity)).toBeNull();
    expect(formatClipSeconds(-3)).toBeNull();
  });
});
