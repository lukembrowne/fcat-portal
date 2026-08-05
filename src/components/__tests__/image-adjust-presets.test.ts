import { describe, it, expect } from "vitest";

import { BRIGHTNESS_PRESET } from "../brightness-control";
import { CONTRAST_PRESET } from "../contrast-control";
import { DEFAULT_BRIGHTNESS, DEFAULT_CONTRAST } from "@/lib/image-filter";

describe("BRIGHTNESS_PRESET", () => {
  // Regression guard on the extraction into ImageAdjustControl: these were
  // hardcoded in the component before, and a drift here changes the slider
  // annotators already use.
  it("keeps the range it had before the shared control existed", () => {
    expect(BRIGHTNESS_PRESET.min).toBe(0.4);
    expect(BRIGHTNESS_PRESET.max).toBe(1.6);
    expect(BRIGHTNESS_PRESET.stepPercent).toBe(5);
  });

  it("keeps its Spanish labels", () => {
    expect(BRIGHTNESS_PRESET.label).toBe("Brillo");
    expect(BRIGHTNESS_PRESET.resetLabel).toBe("Restablecer brillo");
    expect(BRIGHTNESS_PRESET.sliderLabel).toBe("Brillo de la imagen");
  });

  it("still advertises the backslash shortcut", () => {
    expect(BRIGHTNESS_PRESET.sliderTitle).toContain("\\");
  });
});

describe("CONTRAST_PRESET", () => {
  it("is labelled in Spanish, per the project UI convention", () => {
    expect(CONTRAST_PRESET.label).toBe("Contraste");
    expect(CONTRAST_PRESET.resetLabel).toBe("Restablecer contraste");
    expect(CONTRAST_PRESET.sliderLabel).toBe("Contraste de la imagen");
  });

  it("advertises no shortcut — contrast is slider-only", () => {
    expect(CONTRAST_PRESET.sliderTitle).toBeUndefined();
  });

  it("gives more headroom above neutral than below", () => {
    // Raising contrast is what helps on flat frames; the range is deliberately
    // asymmetric rather than mirroring brightness.
    const above = CONTRAST_PRESET.max - CONTRAST_PRESET.defaultValue;
    const below = CONTRAST_PRESET.defaultValue - CONTRAST_PRESET.min;
    expect(above).toBeGreaterThan(below);
  });

  it("spans 0.6 to 2.0 in 5-point steps", () => {
    expect(CONTRAST_PRESET.min).toBe(0.6);
    expect(CONTRAST_PRESET.max).toBe(2.0);
    expect(CONTRAST_PRESET.stepPercent).toBe(5);
  });
});

describe("both presets", () => {
  it("sit at the filter module's neutral values, so composition collapses to a no-op", () => {
    expect(BRIGHTNESS_PRESET.defaultValue).toBe(DEFAULT_BRIGHTNESS);
    expect(CONTRAST_PRESET.defaultValue).toBe(DEFAULT_CONTRAST);
  });

  it("bracket their default, so the reset button is always reachable from either side", () => {
    for (const preset of [BRIGHTNESS_PRESET, CONTRAST_PRESET]) {
      expect(preset.min).toBeLessThan(preset.defaultValue);
      expect(preset.max).toBeGreaterThan(preset.defaultValue);
    }
  });
});
