import { describe, it, expect } from "vitest";
import {
  autoContrast,
  brightnessFilter,
  imageAdjustFilter,
  DEFAULT_BRIGHTNESS,
  DEFAULT_CONTRAST,
  MIN_CONTRAST,
  MAX_CONTRAST,
} from "@/lib/image-filter";

describe("brightnessFilter", () => {
  it("returns empty string at default brightness (no-op)", () => {
    expect(brightnessFilter(1.0)).toBe("");
  });

  it("pairs brightness with mild contrast bump at 0.7", () => {
    // contrast = 1 + (1 - 0.7) * 0.6 = 1.18
    expect(brightnessFilter(0.7)).toBe("brightness(0.7) contrast(1.18)");
  });

  it("pairs brightness with stronger contrast bump at 0.4", () => {
    // contrast = 1 + (1 - 0.4) * 0.6 = 1.36
    expect(brightnessFilter(0.4)).toBe("brightness(0.4) contrast(1.36)");
  });

  it("pairs brightness at 0.5", () => {
    // contrast = 1 + (1 - 0.5) * 0.6 = 1.3
    expect(brightnessFilter(0.5)).toBe("brightness(0.5) contrast(1.3)");
  });

  it("brightens with mild contrast bump at 1.3 (underexposed)", () => {
    // contrast = 1 + |1 - 1.3| * 0.6 = 1.18
    expect(brightnessFilter(1.3)).toBe("brightness(1.3) contrast(1.18)");
  });

  it("brightens with stronger contrast bump at 1.6 (underexposed)", () => {
    // contrast = 1 + |1 - 1.6| * 0.6 = 1.36
    expect(brightnessFilter(1.6)).toBe("brightness(1.6) contrast(1.36)");
  });
});

describe("autoContrast", () => {
  it("is the identity at default brightness, so composition collapses cleanly", () => {
    expect(autoContrast(DEFAULT_BRIGHTNESS)).toBe(1.0);
  });

  it("is symmetric around 1 — darkening and brightening compensate equally", () => {
    expect(autoContrast(0.7)).toBe(autoContrast(1.3));
  });
});

describe("imageAdjustFilter", () => {
  it("returns empty string with both sliders at default", () => {
    expect(imageAdjustFilter(DEFAULT_BRIGHTNESS, DEFAULT_CONTRAST)).toBe("");
  });

  // The regression lock: with contrast untouched, every brightness value the
  // slider and the `\` shortcut can reach must emit exactly what it emitted
  // before the contrast slider existed.
  it.each([0.4, 0.5, 0.7, 1.0, 1.3, 1.6])(
    "at contrast 1.0 reproduces brightnessFilter(%s) byte-for-byte",
    (brightness) => {
      expect(imageAdjustFilter(brightness, DEFAULT_CONTRAST)).toBe(
        brightnessFilter(brightness)
      );
    }
  );

  it("omits the brightness term when only contrast is adjusted", () => {
    expect(imageAdjustFilter(1.0, 1.4)).toBe("contrast(1.4)");
  });

  it("omits the brightness term at minimum contrast too", () => {
    expect(imageAdjustFilter(1.0, MIN_CONTRAST)).toBe("contrast(0.6)");
  });

  it("multiplies user contrast on top of the automatic compensation", () => {
    // auto(0.5) = 1.3, times user 1.3 = 1.69
    expect(imageAdjustFilter(0.5, 1.3)).toBe("brightness(0.5) contrast(1.69)");
  });

  it("rounds the composed contrast to two decimals", () => {
    // auto(0.7) = 1.18, times 1.15 = 1.357 -> 1.36
    expect(imageAdjustFilter(0.7, 1.15)).toBe("brightness(0.7) contrast(1.36)");
  });

  it("stacks both extremes without clamping", () => {
    // auto(0.4) = 1.36, times max 2.0 = 2.72
    expect(imageAdjustFilter(0.4, MAX_CONTRAST)).toBe(
      "brightness(0.4) contrast(2.72)"
    );
  });

  it("drops a composed contrast that rounds back to 1 (pure no-op)", () => {
    // auto(0.7) = 1.18; user 0.85 lands on 1.003 -> rounds to 1.0. Both values
    // are reachable on the sliders (5% steps), so this is a real UI state.
    expect(imageAdjustFilter(0.7, 0.85)).toBe("brightness(0.7)");
  });
});
