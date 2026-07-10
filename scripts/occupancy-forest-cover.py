#!/usr/bin/env python3
"""Occupancy covariate raster pipeline.

Reads ONE JSON config from stdin, streams NDJSON results to stdout (mirrors
scripts/birdnet-runner.py / occupancy-runner.R). Computes, from the Planet
land-cover raster + a Copernicus DEM:
  - per-site forest-cover proportion within a metric buffer, + elevation;
  - an AOI prediction grid (cells over the KML polygon) with forest + elevation
    per cell, for mapping predicted occupancy.

Performance: rather than a per-cell rasterio.mask disk read (thousands of
windowed reads on a 300 MB+ raster), the AOI window of each raster is read into
memory ONCE (decimated to ~samplePixelMeters) and every site/grid sample is a
pure NumPy slice. Web-Mercator scale distortion at the equatorial AOI is
negligible, so a metric buffer radius maps to a fixed pixel radius.

Config (stdin):
  {
    "forestRaster": "/path/planet_landcover.tif",
    "demRaster":    "/path/copernicus_dem.tif" | null,
    "aoiKml":       "/path/aoi.kml" | null,
    "forestClasses": [1, 2],          # raster values counted as "forest"
    "bufferMeters": 500,
    "gridCellMeters": 500,            # AOI grid resolution
    "samplePixelMeters": 20,          # in-memory read resolution (decimation)
    "sites": [{"siteId": "1", "lat": 0.4, "lng": -79.6}, ...]
  }

Emits: {"type":"version"}, {"type":"sites","sites":[...]},
       {"type":"grid","cells":[...]}, {"type":"complete"} | {"type":"error"}.
"""
import json
import sys


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def fail(msg):
    emit({"type": "error", "message": str(msg)})
    sys.exit(1)


def main():
    try:
        import rasterio
        import numpy as np
        from rasterio.windows import Window, from_bounds
        from rasterio.enums import Resampling
        from rasterio.warp import transform_bounds
        from pyproj import Transformer
        from affine import Affine
    except Exception as e:  # noqa: BLE001
        fail(f"missing geo deps (rasterio/pyproj/shapely): {e}")
        return

    emit({"type": "version", "rasterio": rasterio.__version__})

    raw = sys.stdin.read()
    if not raw.strip():
        fail("empty config on stdin")
    cfg = json.loads(raw)

    forest_classes = list(cfg.get("forestClasses", [1]))
    buffer_m = float(cfg.get("bufferMeters", 500))
    sample_px_m = float(cfg.get("samplePixelMeters", 20))
    sites = cfg.get("sites", [])

    forest_path = cfg.get("forestRaster")
    if not forest_path:
        fail("forestRaster path required")

    # --- AOI extent (WGS84), padded so buffers near the edge still have data ---
    aoi = _aoi_bounds_wgs84(cfg, sites, buffer_m)

    def load_window(path):
        """Read the AOI window of `path` into memory once (decimated)."""
        with rasterio.open(path) as src:
            crs = src.crs
            left, bottom, right, top = transform_bounds(
                "EPSG:4326", crs, aoi[0], aoi[1], aoi[2], aoi[3], densify_pts=21
            )
            pad = buffer_m + 1000.0  # raster units ≈ metres near the equator
            win = from_bounds(
                left - pad, bottom - pad, right + pad, top + pad, src.transform
            )
            win = win.intersection(Window(0, 0, src.width, src.height))
            # Native pixel size in METRES — the raster may be projected (units
            # already metres, e.g. EPSG:3857) or geographic (degrees, e.g. a
            # WGS84 DEM), so convert degrees→metres before deriving decimation.
            native_unit = abs(src.transform.a) or 1.0
            native_m = native_unit * 111320.0 if crs.is_geographic else native_unit
            dec = max(1, int(round(sample_px_m / native_m)))
            out_h = max(1, int(round(win.height / dec)))
            out_w = max(1, int(round(win.width / dec)))
            arr = src.read(
                1, window=win, out_shape=(out_h, out_w), resampling=Resampling.nearest
            )
            wt = src.window_transform(win)
            at = wt * Affine.scale(win.width / out_w, win.height / out_h)
            return {
                "arr": arr,
                "inv": ~at,
                "pixel_m": abs(at.a) or native_m,
                "nodata": src.nodata,
                "tx": Transformer.from_crs("EPSG:4326", crs, always_xy=True),
                "h": out_h,
                "w": out_w,
            }

    F = load_window(forest_path)
    forest_set = set(forest_classes)

    def forest_fraction(lat, lng):
        x, y = F["tx"].transform(lng, lat)
        col, row = F["inv"] * (x, y)
        r, c = int(row), int(col)
        rad = max(1, int(round(buffer_m / F["pixel_m"])))
        r0, r1 = max(0, r - rad), min(F["h"], r + rad + 1)
        c0, c1 = max(0, c - rad), min(F["w"], c + rad + 1)
        if r1 <= r0 or c1 <= c0:
            return None
        sub = F["arr"][r0:r1, c0:c1]
        yy, xx = np.ogrid[r0 - r : r1 - r, c0 - c : c1 - c]
        vals = sub[(yy * yy + xx * xx) <= rad * rad]
        nod = F["nodata"]
        if nod is not None:
            vals = vals[vals != nod]
        if vals.size == 0:
            return None
        return float(np.isin(vals, forest_classes).sum()) / float(vals.size)

    dem_path = cfg.get("demRaster")
    D = load_window(dem_path) if dem_path else None

    def elevation(lat, lng):
        if D is None:
            return None
        x, y = D["tx"].transform(lng, lat)
        col, row = D["inv"] * (x, y)
        r, c = int(row), int(col)
        if r < 0 or r >= D["h"] or c < 0 or c >= D["w"]:
            return None
        v = D["arr"][r, c]
        if D["nodata"] is not None and v == D["nodata"]:
            return None
        return float(v)

    # Per-site covariates.
    out_sites = [
        {
            "siteId": s["siteId"],
            "forestCover": forest_fraction(float(s["lat"]), float(s["lng"])),
            "elevation": elevation(float(s["lat"]), float(s["lng"])),
        }
        for s in sites
    ]
    emit({"type": "sites", "sites": out_sites})

    # AOI prediction grid.
    aoi_path = cfg.get("aoiKml")
    cell_m = float(cfg.get("gridCellMeters", 500))
    if aoi_path:
        poly = _load_kml_polygon(aoi_path)
        if poly is not None:
            to_metric = Transformer.from_crs("EPSG:4326", "EPSG:32717", always_xy=True)
            cells = _grid_cells(poly, cell_m, to_metric, forest_fraction, elevation)
            emit({"type": "grid", "cells": cells})

    emit({"type": "complete"})


def _aoi_bounds_wgs84(cfg, sites, buffer_m):
    """AOI bounding box in WGS84 (w, s, e, n) from the KML, else the site bbox."""
    poly = _load_kml_polygon(cfg["aoiKml"]) if cfg.get("aoiKml") else None
    if poly is not None:
        w, s, e, n = poly.bounds
    elif sites:
        lats = [float(x["lat"]) for x in sites]
        lngs = [float(x["lng"]) for x in sites]
        w, s, e, n = min(lngs), min(lats), max(lngs), max(lats)
    else:
        return (-180.0, -85.0, 180.0, 85.0)
    dpad = (buffer_m + 1000.0) / 111000.0  # degrees
    return (w - dpad, s - dpad, e + dpad, n + dpad)


def _load_kml_polygon(path):
    """Parse the first polygon out of a KML file (minimal, dependency-light)."""
    import re
    from shapely.geometry import Polygon

    try:
        with open(path, "r", encoding="utf-8") as fh:
            txt = fh.read()
    except Exception:  # noqa: BLE001
        return None
    m = re.search(r"<coordinates>\s*(.*?)\s*</coordinates>", txt, re.S)
    if not m:
        return None
    coords = []
    for tok in m.group(1).split():
        parts = tok.split(",")
        if len(parts) >= 2:
            coords.append((float(parts[0]), float(parts[1])))
    if len(coords) < 3:
        return None
    return Polygon(coords)


def _grid_cells(poly, cell_m, to_metric, forest_fraction, elevation):
    """Regular grid of cell centroids inside the AOI polygon (WGS84)."""
    from pyproj import Transformer
    from shapely.geometry import Point
    from shapely.ops import transform as shp_transform

    from_metric = Transformer.from_crs("EPSG:32717", "EPSG:4326", always_xy=True)
    # Project the polygon to metric to step in meters.
    poly_m = shp_transform(lambda x, y, z=None: to_metric.transform(x, y), poly)
    minx, miny, maxx, maxy = poly_m.bounds
    cells = []
    y = miny
    while y <= maxy:
        x = minx
        while x <= maxx:
            pt_m = Point(x, y)
            if poly_m.contains(pt_m):
                lng, lat = from_metric.transform(x, y)
                cells.append(
                    {
                        "lat": round(lat, 6),
                        "lng": round(lng, 6),
                        "forestCover": forest_fraction(lat, lng),
                        "elevation": elevation(lat, lng),
                    }
                )
            x += cell_m
        y += cell_m
    return cells


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        fail(str(e))
