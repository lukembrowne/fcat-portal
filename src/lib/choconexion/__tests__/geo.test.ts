import { describe, it, expect } from "vitest";

import {
  toViewerXY,
  fromViewerXY,
  isWithinPlotCluster,
  roundXY,
} from "../geo";

// REF-007 (P07) as recorded in biochoco_deployments.
const REF_007 = { latitude: 0.380093432, longitude: -79.66060772 };

describe("toViewerXY", () => {
  it("places a known site inside the plot cluster's bounding box", () => {
    const xy = toViewerXY(REF_007.latitude, REF_007.longitude);

    expect(xy.x).toBeGreaterThan(648_600);
    expect(xy.x).toBeLessThan(649_300);
    expect(xy.y).toBeGreaterThan(41_000);
    expect(xy.y).toBeLessThan(42_300);
  });

  it("round-trips back to the input coordinates", () => {
    const xy = toViewerXY(REF_007.latitude, REF_007.longitude);
    const back = fromViewerXY(xy.x, xy.y);

    expect(back.latitude).toBeCloseTo(REF_007.latitude, 6);
    expect(back.longitude).toBeCloseTo(REF_007.longitude, 6);
  });

  it("is deterministic", () => {
    const a = toViewerXY(REF_007.latitude, REF_007.longitude);
    const b = toViewerXY(REF_007.latitude, REF_007.longitude);
    expect(a).toEqual(b);
  });

  it("throws on a null-ish or non-finite coordinate rather than emitting NaN", () => {
    // A deployment with no recorded position reaches here as null; emitting a
    // NaN marker would put it at the origin of the point cloud.
    expect(() => toViewerXY(NaN, -79.6)).toThrow();
    expect(() => toViewerXY(0.38, Infinity)).toThrow();
    expect(() => toViewerXY(null as unknown as number, -79.6)).toThrow();
  });
});

describe("isWithinPlotCluster", () => {
  it("accepts every site in the experiment", () => {
    // All 15 sites with a recorded position, from biochoco_deployments.
    const sites: Array<[number, number]> = [
      [0.372197617, -79.66153632],
      [0.37289797, -79.66241272],
      [0.3733375, -79.6632881],
      [0.3731824, -79.6608609],
      [0.373848573, -79.66176226],
      [0.3745669, -79.6626793],
      [0.380093432, -79.66060772],
      [0.3804018, -79.6589755],
      [0.381368294, -79.65848696],
      [0.380685006, -79.65754271],
      [0.3816681, -79.6572353],
      [0.3814106, -79.6559489],
      [0.3760846, -79.6617662],
      [0.376703456, -79.666043],
      [0.375726662, -79.66877655],
    ];

    for (const [lat, lng] of sites) {
      expect(isWithinPlotCluster(toViewerXY(lat, lng))).toBe(true);
    }
  });

  it("rejects a swapped latitude/longitude pair", () => {
    // The most likely data error, and one that still reprojects successfully.
    expect(isWithinPlotCluster(toViewerXY(-79.66060772, 0.380093432))).toBe(false);
  });

  it("rejects a sign-flipped longitude", () => {
    expect(isWithinPlotCluster(toViewerXY(0.380093432, 79.66060772))).toBe(false);
  });

  it("rejects a BioChoco site outside the experiment", () => {
    // CCN-010, roughly 8 km from the plot cluster.
    expect(isWithinPlotCluster(toViewerXY(0.4441, -79.7086))).toBe(false);
  });
});

describe("roundXY", () => {
  it("rounds to centimetres", () => {
    expect(roundXY({ x: 649_052.123456, y: 42_023.987654 })).toEqual({
      x: 649_052.12,
      y: 42_023.99,
    });
  });

  it("is idempotent, so re-exporting an unchanged site produces no diff", () => {
    const once = roundXY(toViewerXY(REF_007.latitude, REF_007.longitude));
    expect(roundXY(once)).toEqual(once);
  });
});
