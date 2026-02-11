import { describe, it, expect } from "vitest";
import { toUtm17N, formatUtm } from "../utm";

describe("toUtm17N", () => {
  it("converts a known FCAT-area coordinate (0.5°N, -79.7°W)", () => {
    // Reference: 0.5°N, -79.7°W → Zone 17N
    // Cross-checked: equator at CM gives exactly 500000 E / 0 N (see test below)
    const result = toUtm17N(0.5, -79.7);

    expect(result.zone).toBe(17);
    expect(result.hemisphere).toBe("N");
    // Easting should be > 500000 (east of CM at -81°)
    expect(result.easting).toBeGreaterThan(600000);
    expect(result.easting).toBeLessThan(700000);
    // Northing should be positive and modest (0.5° north of equator)
    expect(result.northing).toBeGreaterThan(50000);
    expect(result.northing).toBeLessThan(60000);
  });

  it("converts the equator at the central meridian (-81°)", () => {
    const result = toUtm17N(0, -81);

    expect(result.zone).toBe(17);
    // At CM, easting should be exactly 500,000
    expect(Math.round(result.easting)).toBe(500000);
    // At equator in northern hemisphere, northing should be 0
    expect(Math.round(result.northing)).toBe(0);
  });

  it("returns reasonable values for typical Ecuador coordinates", () => {
    // Canandé reserve area, roughly 0.5°N, 79.2°W
    const result = toUtm17N(0.52, -79.2);

    expect(result.easting).toBeGreaterThan(100000);
    expect(result.easting).toBeLessThan(900000);
    expect(result.northing).toBeGreaterThan(0);
    expect(result.northing).toBeLessThan(200000);
  });
});

describe("formatUtm", () => {
  it("formats a UTM coordinate with thousand separators", () => {
    const formatted = formatUtm({
      easting: 699123.456,
      northing: 55302.789,
      zone: 17,
      hemisphere: "N",
    });

    expect(formatted).toBe("699,123 E  55,303 N");
  });
});
