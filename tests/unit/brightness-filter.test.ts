import { describe, it, expect } from "vitest";
import { brightnessFilter } from "@/lib/brightness-filter";

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
