import { describe, it, expect } from "vitest";
import { renderImageData } from "@/lib/spectrogram-render";
import { COLORMAPS } from "@/lib/spectrogram-colormaps";

describe("spectrogram-render", () => {
  it("produces an image with dimensions = numFrames x displayMaxBin", () => {
    const numFrames = 10;
    const binCount = 8;
    const magnitudes = new Float32Array(numFrames * binCount);
    const img = renderImageData({
      magnitudes,
      numFrames,
      binCount,
      displayMaxBin: 5,
      gainDB: 0,
      rangeDB: 70,
      lut: COLORMAPS.viridis,
    });
    expect(img.width).toBe(10);
    expect(img.height).toBe(5);
    expect(img.data.length).toBe(10 * 5 * 4);
  });

  it("y-flips so low-frequency rows render at the bottom", () => {
    const numFrames = 1;
    const binCount = 4;
    const magnitudes = new Float32Array([-100, -80, -40, 0]);
    const img = renderImageData({
      magnitudes,
      numFrames,
      binCount,
      displayMaxBin: 4,
      gainDB: 0,
      rangeDB: 80,
      lut: COLORMAPS.viridis,
    });

    const lumAtY = (y: number) => {
      const px = (y * img.width) * 4;
      return img.data[px] + img.data[px + 1] + img.data[px + 2];
    };

    expect(lumAtY(3)).toBeLessThan(lumAtY(0));
  });

  it("monotonically increasing magnitudes produce monotonically changing LUT indices", () => {
    const numFrames = 1;
    const binCount = 5;
    const magnitudes = new Float32Array([-80, -60, -40, -20, 0]);
    const img = renderImageData({
      magnitudes,
      numFrames,
      binCount,
      displayMaxBin: 5,
      gainDB: 0,
      rangeDB: 80,
      lut: COLORMAPS.turbo,
    });

    const seen: string[] = [];
    for (let y = img.height - 1; y >= 0; y--) {
      const px = y * img.width * 4;
      seen.push(`${img.data[px]},${img.data[px + 1]},${img.data[px + 2]}`);
    }
    const unique = new Set(seen);
    expect(unique.size).toBe(5);
  });

  it("clamps out-of-range magnitudes to LUT endpoints", () => {
    const numFrames = 1;
    const binCount = 2;
    const magnitudes = new Float32Array([-9999, 9999]);
    const img = renderImageData({
      magnitudes,
      numFrames,
      binCount,
      displayMaxBin: 2,
      gainDB: 0,
      rangeDB: 70,
      lut: COLORMAPS.magma,
    });

    const top = img.data;
    const bot = img.data.slice(4);
    expect(top[0]).toBe(COLORMAPS.magma[255 * 3]);
    expect(bot[0]).toBe(COLORMAPS.magma[0]);
  });
});
