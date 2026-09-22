/**
 * The review clip's axis ticks.
 *
 * The assertions that matter are the two ends of each axis: the step a reviewer
 * actually sees on a default clip (2 kHz, 1 s), and the degenerate inputs that
 * occur on every clip's first frame — an unknown duration and an unmeasured box.
 */

import { describe, expect, it } from "vitest";

import {
  freqStepHz,
  freqTicks,
  timeStepSeconds,
  timeTicks,
} from "../clip-axes";

describe("freqStepHz", () => {
  it("uses 2 kHz on every ceiling the controls offer", () => {
    // 6/9/12 kHz are the MAX_HZ_PRESETS a reviewer picks from, and 12 is the
    // default the server renderer also uses.
    expect(freqStepHz(12000)).toBe(2000);
    expect(freqStepHz(9000)).toBe(2000);
    expect(freqStepHz(6000)).toBe(2000);
  });

  it("goes finer when 2 kHz would print two labels", () => {
    expect(freqStepHz(3000)).toBe(1000);
    expect(freqStepHz(2000)).toBe(500);
  });

  it("goes coarser on a full-Nyquist ceiling", () => {
    // 24 kHz is half a 48 kHz recorder's rate, offered as the "Máx" preset.
    expect(freqStepHz(24000)).toBe(4000);
    expect(freqStepHz(48000)).toBe(8000);
  });
});

describe("freqTicks", () => {
  it("walks 0 to the ceiling in 2 kHz steps, bottom to top", () => {
    const ticks = freqTicks(12000);
    expect(ticks.map((t) => t.hz)).toEqual([
      0, 2000, 4000, 6000, 8000, 10000, 12000,
    ]);
    // 0 Hz sits at the BOTTOM of the image: the renderer flips the bins.
    expect(ticks[0].topPct).toBe(100);
    expect(ticks[ticks.length - 1].topPct).toBe(0);
    expect(ticks[3].topPct).toBe(50);
  });

  it("carries the unit on the topmost label only", () => {
    const ticks = freqTicks(12000);
    expect(ticks[ticks.length - 1].label).toBe("12 kHz");
    expect(ticks.slice(0, -1).map((t) => t.label)).toEqual([
      "0",
      "2",
      "4",
      "6",
      "8",
      "10",
    ]);
  });

  it("stops below a ceiling the step does not divide", () => {
    // A 9 kHz ceiling's top label is 8 kHz, drawn at 11.1% from the top —
    // NOT stretched to the edge, which would misplace every line below it.
    const ticks = freqTicks(9000);
    expect(ticks.map((t) => t.hz)).toEqual([0, 2000, 4000, 6000, 8000]);
    expect(ticks[4].topPct).toBeCloseTo(11.11, 2);
  });

  it("labels a half-kHz step with one decimal", () => {
    expect(freqTicks(2000).map((t) => t.label)).toEqual([
      "0",
      "0.5",
      "1",
      "1.5",
      "2 kHz",
    ]);
  });

  it("renders nothing for a ceiling that is not a usable number", () => {
    expect(freqTicks(0)).toEqual([]);
    expect(freqTicks(NaN)).toEqual([]);
    expect(freqTicks(-12000)).toEqual([]);
  });
});

describe("timeStepSeconds", () => {
  it("puts a tick every second on an unzoomed clip", () => {
    // ~9 s (detection ±3 s) across a typical review card.
    expect(timeStepSeconds(9, 800)).toBe(1);
  });

  it("gets finer as the reviewer zooms, because the pixels are there", () => {
    expect(timeStepSeconds(9, 800 * 2)).toBe(0.5);
    expect(timeStepSeconds(9, 800 * 4)).toBe(0.25);
  });

  it("gets coarser on a narrow box rather than crowding it", () => {
    expect(timeStepSeconds(9, 300)).toBe(2);
  });

  it("waits for a duration and a measured width", () => {
    // Both hold on every clip's first frame: metadata has not loaded and the
    // ResizeObserver has not fired.
    expect(timeStepSeconds(null, 800)).toBeNull();
    expect(timeStepSeconds(9, null)).toBeNull();
    expect(timeStepSeconds(NaN, 800)).toBeNull();
    expect(timeStepSeconds(9, 0)).toBeNull();
  });
});

describe("timeTicks", () => {
  it("starts at 0 and stops inside the clip", () => {
    const ticks = timeTicks(9, 800);
    expect(ticks.map((t) => t.seconds)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(ticks[0].leftPct).toBe(0);
    expect(ticks[9].leftPct).toBe(100);
  });

  it("does not run past the end of a clip the window overshot", () => {
    // ffmpeg returns a short file when the requested window passes the end of
    // the recording — 5 s instead of 9 on BirdNET's last window. A tick at 9 s
    // would sit off the right-hand edge of that picture.
    const ticks = timeTicks(5.2, 800);
    expect(ticks[ticks.length - 1].seconds).toBe(5);
    expect(ticks[ticks.length - 1].leftPct).toBeCloseTo(96.15, 2);
  });

  it("labels in seconds, with just enough decimals for the step", () => {
    expect(timeTicks(9, 800).map((t) => t.label).slice(0, 3)).toEqual([
      "0 s",
      "1 s",
      "2 s",
    ]);
    expect(timeTicks(9, 3200).map((t) => t.label).slice(0, 3)).toEqual([
      "0 s",
      "0.25 s",
      "0.50 s",
    ]);
  });

  it("renders nothing until the clip and the box are both known", () => {
    expect(timeTicks(null, 800)).toEqual([]);
    expect(timeTicks(9, null)).toEqual([]);
  });
});
