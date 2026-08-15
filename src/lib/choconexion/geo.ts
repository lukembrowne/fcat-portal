/**
 * Coordinate conversion between the portal and the Choconexión viewer.
 *
 * The portal stores deployment positions as WGS84 decimal degrees; the viewer's
 * point cloud, plot polygons and marker positions are all in UTM zone 17N
 * (EPSG:32617, declared as `crs` in the repo's `plots.json`). The export owns
 * the reprojection so the bundle needs no transform at load time.
 *
 * Elevation is deliberately absent. The portal stores none for a deployment, so
 * marker height is derived in the viewer from the containing plot's recorded
 * elevation — see the sites layer in the Choconexión repo.
 */

import proj4 from "proj4";

const WGS84 = "EPSG:4326";

/**
 * Written out rather than referenced by EPSG code: proj4 ships definitions for
 * a handful of codes only, and `EPSG:32617` is not among them.
 */
const UTM_17N = "+proj=utm +zone=17 +datum=WGS84 +units=m +no_defs";

export interface ViewerXY {
  /** Easting, metres. */
  x: number;
  /** Northing, metres. */
  y: number;
}

/**
 * Bounding box of the plot cluster, with roughly 500 m of slack on each side.
 * A reprojected site outside this is a data error (a swapped lat/lng pair, a
 * sign flip, a deployment that is not actually in the experiment), not a marker
 * the viewer should place 40 km away.
 */
const PLAUSIBLE_BOUNDS = {
  minX: 648_000,
  maxX: 650_000,
  minY: 40_500,
  maxY: 42_800,
} as const;

/** Reproject WGS84 degrees to the viewer's coordinate system. */
export function toViewerXY(latitude: number, longitude: number): ViewerXY {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error(
      `Coordenadas inválidas: lat=${latitude}, lng=${longitude}`,
    );
  }
  const [x, y] = proj4(WGS84, UTM_17N, [longitude, latitude]);
  return { x, y };
}

/** Inverse of `toViewerXY`, for round-trip verification. */
export function fromViewerXY(x: number, y: number): { latitude: number; longitude: number } {
  const [longitude, latitude] = proj4(UTM_17N, WGS84, [x, y]);
  return { latitude, longitude };
}

/** Whether a reprojected position falls near the Choconexión plot cluster. */
export function isWithinPlotCluster({ x, y }: ViewerXY): boolean {
  return (
    x >= PLAUSIBLE_BOUNDS.minX &&
    x <= PLAUSIBLE_BOUNDS.maxX &&
    y >= PLAUSIBLE_BOUNDS.minY &&
    y <= PLAUSIBLE_BOUNDS.maxY
  );
}

/** Round to centimetres. Millimetre noise in a committed file is diff churn. */
export function roundXY({ x, y }: ViewerXY): ViewerXY {
  return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
}
