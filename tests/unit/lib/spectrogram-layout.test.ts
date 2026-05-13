import { describe, it, expect } from "vitest";
import {
  FREQ_AXIS_WIDTH,
  TIME_AXIS_HEIGHT,
  SPEC_HEIGHT_PRESETS,
  ZOOM_LEVELS,
  HEIGHT_PRESETS,
  heightForPreset,
  isHeightPreset,
  isZoomLevel,
} from "@/lib/spectrogram-layout";

describe("spectrogram-layout", () => {
  describe("constants", () => {
    it("FREQ_AXIS_WIDTH matches the value currently inlined in fft-spectrogram + annotation-client", () => {
      // If this changes, audit every callsite — the gutter width is duplicated
      // in popover-anchor math (annotation-client) and the spec layout itself.
      expect(FREQ_AXIS_WIDTH).toBe(70);
    });

    it("TIME_AXIS_HEIGHT matches the existing layout", () => {
      expect(TIME_AXIS_HEIGHT).toBe(24);
    });

    it("SPEC_HEIGHT_PRESETS exposes three preset heights in ascending order", () => {
      expect(SPEC_HEIGHT_PRESETS.compacto).toBe(256);
      expect(SPEC_HEIGHT_PRESETS.comodo).toBe(350);
      expect(SPEC_HEIGHT_PRESETS.alto).toBe(480);
      expect(SPEC_HEIGHT_PRESETS.compacto).toBeLessThan(SPEC_HEIGHT_PRESETS.comodo);
      expect(SPEC_HEIGHT_PRESETS.comodo).toBeLessThan(SPEC_HEIGHT_PRESETS.alto);
    });

    it("ZOOM_LEVELS is a power-of-2 progression for predictable label-collapse thresholds", () => {
      expect(ZOOM_LEVELS).toEqual([1, 2, 4, 8]);
    });

    it("HEIGHT_PRESETS lists every key in SPEC_HEIGHT_PRESETS", () => {
      expect(new Set(HEIGHT_PRESETS)).toEqual(
        new Set(Object.keys(SPEC_HEIGHT_PRESETS)),
      );
    });
  });

  describe("heightForPreset", () => {
    it("resolves each preset to its pixel height", () => {
      expect(heightForPreset("compacto")).toBe(256);
      expect(heightForPreset("comodo")).toBe(350);
      expect(heightForPreset("alto")).toBe(480);
    });
  });

  describe("isHeightPreset", () => {
    it("accepts only the three known preset keys", () => {
      expect(isHeightPreset("compacto")).toBe(true);
      expect(isHeightPreset("comodo")).toBe(true);
      expect(isHeightPreset("alto")).toBe(true);
    });

    it("rejects everything else, including near-misses", () => {
      expect(isHeightPreset("comfortable")).toBe(false);
      expect(isHeightPreset("COMPACTO")).toBe(false);
      expect(isHeightPreset("")).toBe(false);
      expect(isHeightPreset(null)).toBe(false);
      expect(isHeightPreset(undefined)).toBe(false);
      expect(isHeightPreset(256)).toBe(false);
      expect(isHeightPreset({})).toBe(false);
      // Defends against prototype pollution / inherited-property attacks.
      expect(isHeightPreset("toString")).toBe(false);
    });
  });

  describe("isZoomLevel", () => {
    it("accepts only the four discrete zoom levels", () => {
      expect(isZoomLevel(1)).toBe(true);
      expect(isZoomLevel(2)).toBe(true);
      expect(isZoomLevel(4)).toBe(true);
      expect(isZoomLevel(8)).toBe(true);
    });

    it("rejects non-power-of-2, non-number, and out-of-range values", () => {
      expect(isZoomLevel(3)).toBe(false);
      expect(isZoomLevel(16)).toBe(false);
      expect(isZoomLevel(0)).toBe(false);
      expect(isZoomLevel(-1)).toBe(false);
      expect(isZoomLevel("1")).toBe(false);
      expect(isZoomLevel(null)).toBe(false);
      expect(isZoomLevel(undefined)).toBe(false);
    });
  });
});
