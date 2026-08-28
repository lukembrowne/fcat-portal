/**
 * The review queue's spectrogram settings.
 *
 * The load-bearing assertion here is the first one: the defaults must equal the
 * constants the server renderer uses. A reviewer who never touches the controls
 * must see exactly the picture they saw before this feature existed, because
 * the two surfaces are swapped underneath them by whether a panel is open.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  isDefault,
  normalize,
  type ReviewSpectrogramSettings,
} from "../spectrogram-settings";

/** Pull a `const NAME = <number>;` out of the server renderer's source. */
function serverConstant(name: string): number {
  const source = readFileSync(
    new URL("../../../../../../lib/spectrogram-image.ts", import.meta.url),
    "utf8"
  );
  const match = source.match(new RegExp(`const ${name} = (\\d+)`));
  if (!match) throw new Error(`${name} not found in spectrogram-image.ts`);
  return Number(match[1]);
}

describe("defaults match the server renderer", () => {
  it("uses the same FFT size, gain, range and frequency ceiling", () => {
    expect(DEFAULT_SETTINGS.fftSize).toBe(serverConstant("FFT_SIZE"));
    expect(DEFAULT_SETTINGS.gainDB).toBe(serverConstant("GAIN_DB"));
    expect(DEFAULT_SETTINGS.rangeDB).toBe(serverConstant("RANGE_DB"));
    expect(DEFAULT_SETTINGS.displayMaxHz).toBe(serverConstant("DISPLAY_MAX_HZ"));
  });

  it("starts unzoomed, so the clip fills the box exactly as the image does", () => {
    expect(DEFAULT_SETTINGS.zoom).toBe(1);
  });
});

describe("normalize", () => {
  it("falls back to defaults on junk", () => {
    expect(normalize(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalize("nope")).toEqual(DEFAULT_SETTINGS);
    expect(normalize({ fftSize: 999, gainDB: "loud" })).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps a stored setting that is still valid", () => {
    const stored = normalize({ fftSize: 2048, gainDB: 30, zoom: 4 });
    expect(stored.fftSize).toBe(2048);
    expect(stored.gainDB).toBe(30);
    expect(stored.zoom).toBe(4);
  });

  it("clamps out-of-range numbers rather than dropping them", () => {
    expect(normalize({ gainDB: 500 }).gainDB).toBe(48);
    expect(normalize({ gainDB: -20 }).gainDB).toBe(0);
  });

  it("accepts a non-preset frequency ceiling (a recorder's own Nyquist)", () => {
    expect(normalize({ displayMaxHz: 24000 }).displayMaxHz).toBe(24000);
  });
});

describe("isDefault", () => {
  it("is true for the shipped defaults", () => {
    expect(isDefault(DEFAULT_SETTINGS)).toBe(true);
  });

  it("is false once any knob moves, so the summary line appears", () => {
    const knobs: Array<Partial<ReviewSpectrogramSettings>> = [
      { fftSize: 512 },
      { gainDB: 19 },
      { rangeDB: 71 },
      { displayMaxHz: 6000 },
      { zoom: 2 },
    ];
    for (const knob of knobs) {
      expect(isDefault({ ...DEFAULT_SETTINGS, ...knob })).toBe(false);
    }
  });
});
