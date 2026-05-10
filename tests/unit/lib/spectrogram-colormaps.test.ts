import { describe, it, expect } from "vitest";
import { COLORMAPS, COLORMAP_NAMES } from "@/lib/spectrogram-colormaps";

describe("spectrogram-colormaps", () => {
  it("provides 256-entry RGB LUTs for every registered colormap", () => {
    expect(COLORMAP_NAMES).toEqual(["viridis", "magma", "inferno", "turbo", "grayscale"]);
    for (const name of COLORMAP_NAMES) {
      const lut = COLORMAPS[name];
      expect(lut).toBeInstanceOf(Uint8ClampedArray);
      expect(lut.length).toBe(256 * 3);
    }
  });

  it("grayscale colormap is inverted (low energy = white)", () => {
    const lut = COLORMAPS.grayscale;
    expect(lut[0]).toBe(255);
    expect(lut[1]).toBe(255);
    expect(lut[2]).toBe(255);
    expect(lut[255 * 3]).toBe(0);
    expect(lut[255 * 3 + 1]).toBe(0);
    expect(lut[255 * 3 + 2]).toBe(0);
  });

  it("lookup at 0 and 255 is distinct for every colormap", () => {
    for (const name of COLORMAP_NAMES) {
      const lut = COLORMAPS[name];
      const first = `${lut[0]},${lut[1]},${lut[2]}`;
      const last = `${lut[255 * 3]},${lut[255 * 3 + 1]},${lut[255 * 3 + 2]}`;
      expect(first).not.toBe(last);
    }
  });
});
