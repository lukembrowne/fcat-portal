import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), debug: vi.fn() } }));

const { paddedBbox } = await import("@/lib/occupancy/surface");

describe("paddedBbox", () => {
  it("returns the cell-edge extent, padded half a cell", () => {
    // 2x2 grid at 0.01 spacing.
    const cells = [
      { lat: 0.30, lng: -79.60 },
      { lat: 0.30, lng: -79.59 },
      { lat: 0.31, lng: -79.60 },
      { lat: 0.31, lng: -79.59 },
    ];
    const b = paddedBbox(cells)!;
    expect(b).not.toBeNull();
    // minLng - dLng/2, minLat - dLat/2, maxLng + dLng/2, maxLat + dLat/2
    expect(b[0]).toBeCloseTo(-79.605, 6);
    expect(b[1]).toBeCloseTo(0.295, 6);
    expect(b[2]).toBeCloseTo(-79.585, 6);
    expect(b[3]).toBeCloseTo(0.315, 6);
  });

  it("returns null for an empty grid", () => {
    expect(paddedBbox([])).toBeNull();
  });
});
