#!/usr/bin/env python3
"""Colorize an occupancy grid into a transparent PNG for a Leaflet ImageOverlay.

Reads ONE JSON config from stdin, writes an RGBA PNG, prints ONE JSON line with
the geographic edge bounds. Used by src/lib/occupancy/surface.ts to turn the
per-cell prediction / covariate grids into raster surfaces instead of a mesh of
circle markers.

The grid cells sit on a near-regular lattice (stepped in UTM, reprojected to
WGS84), so cells are binned onto a regular lat/lng raster at the cell spacing —
robust to the small reprojection skew. Empty pixels stay transparent.

Config (stdin):
  {
    "cells": [{"lat": 0.4, "lng": -79.6, "value": 0.57 | null}, ...],
    "ramp":  "psi" | "forest" | "elevation",
    "out":   "/path/surface.png",
    "vmin":  0, "vmax": 1                # optional; else data min/max
  }
Prints: {"bounds":[minLng,minLat,maxLng,maxLat],"nx":..,"ny":..,"vmin":..,"vmax":..}
"""
import json
import sys

# (light, dark) RGB endpoints. "psi" is a purple ramp (NOT green) so occupancy /
# richness surfaces are never confused with the green forest-cover layer.
RAMPS = {
    "psi": ((240, 233, 248), (74, 20, 134)),
    "forest": ((224, 243, 248), (8, 64, 129)),
    "elevation": ((255, 255, 204), (102, 37, 6)),
}
MAX_DIM = 2000  # safety cap on raster dimensions


def main():
    from PIL import Image
    import numpy as np

    cfg = json.load(sys.stdin)
    cells = cfg.get("cells", [])
    if not cells:
        print(json.dumps({"error": "no cells"}))
        return

    lats = [c["lat"] for c in cells]
    lngs = [c["lng"] for c in cells]
    minlat, maxlat = min(lats), max(lats)
    minlng, maxlng = min(lngs), max(lngs)
    rlat = (maxlat - minlat) or 1e-9
    rlng = (maxlng - minlng) or 1e-9
    # The grid is stepped in UTM then reprojected, so lat/lng are NOT a clean
    # lattice (meridian skew ⇒ near-unique coords). Derive the true row/col count
    # from the cell count + aspect ratio rather than coordinate gaps (which would
    # collapse to ~0 and blow up the raster size).
    n = len(cells)
    aspect = rlng / rlat
    ny = max(1, min(MAX_DIM, round((n / aspect) ** 0.5)))
    nx = max(1, min(MAX_DIM, round(n / ny)))

    grid = np.full((ny, nx), np.nan, dtype=float)
    for c in cells:
        v = c.get("value")
        if v is None:
            continue
        col = round((c["lng"] - minlng) / rlng * (nx - 1)) if nx > 1 else 0
        row = round((maxlat - c["lat"]) / rlat * (ny - 1)) if ny > 1 else 0  # row 0 = north
        if 0 <= row < ny and 0 <= col < nx:
            grid[row, col] = v

    dlng = rlng / (nx - 1) if nx > 1 else rlng
    dlat = rlat / (ny - 1) if ny > 1 else rlat

    finite = grid[np.isfinite(grid)]
    vmin = cfg.get("vmin")
    vmax = cfg.get("vmax")
    if vmin is None:
        vmin = float(finite.min()) if finite.size else 0.0
    if vmax is None:
        vmax = float(finite.max()) if finite.size else 1.0
    if vmax <= vmin:
        vmax = vmin + 1e-9

    lo, hi = RAMPS.get(cfg.get("ramp", "psi"), RAMPS["psi"])
    t = np.clip((grid - vmin) / (vmax - vmin), 0.0, 1.0)
    valid = np.isfinite(grid)
    rgba = np.zeros((ny, nx, 4), dtype=np.uint8)
    for k in range(3):
        rgba[..., k] = np.where(valid, lo[k] + t * (hi[k] - lo[k]), 0).astype(np.uint8)
    rgba[..., 3] = np.where(valid, 205, 0).astype(np.uint8)  # ~0.8 opacity

    Image.fromarray(rgba, "RGBA").save(cfg["out"])
    print(
        json.dumps(
            {
                "bounds": [
                    minlng - dlng / 2,
                    minlat - dlat / 2,
                    maxlng + dlng / 2,
                    maxlat + dlat / 2,
                ],
                "nx": nx,
                "ny": ny,
                "vmin": vmin,
                "vmax": vmax,
            }
        )
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
