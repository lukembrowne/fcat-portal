#!/usr/bin/env python3
"""High-resolution occupancy surface renderer.

Reads ONE JSON config from stdin, writes colorized RGBA PNGs, prints ONE JSON
line with the geographic bounds. Unlike scripts/occupancy-render-surface.py
(which colorizes the coarse ~500 m prediction grid), this reads the NATIVE
forest / DEM rasters directly and renders at a fine display resolution so the
map shows real landscape structure instead of a blurred 500 m mosaic:

  - forest layer:     forest-cover fraction in a small window per display pixel
                      (reveals patches / clearings the model's 500 m buffer hides)
  - elevation layer:  the DEM sampled onto the display grid
  - per-model ψ:      plogis(b0 + bForest·zForest + bElev·zElev) evaluated per
                      pixel, where zForest uses the SAME 500 m buffered cover the
                      model was fit on (so the surface matches the fit) and the
                      standardization {mean,sd} the model saw. Habitat (if any) is
                      held at its reference level = folded into the intercept.

Everything is clipped to the AOI polygon (transparent outside). The heavy raster
read + integral-image happen ONCE; each model ψ is then vectorized arithmetic.

Config (stdin):
  {
    "forestRaster": path, "demRaster": path|null, "forestClasses": [1],
    "bufferMeters": 500,           # ψ forest-cover buffer (match the model)
    "forestLayerMeters": 60,       # forest LAYER window (fine detail)
    "aoiKml": path,                # AOI polygon (bounds + clip mask)
    "displayMeters": 25,           # display pixel size
    "outDir": "data/occupancy-models/17",
    "forest":    {"out": "_forest.png"}       | null,
    "elevation": {"out": "_elevation.png"}    | null,
    "models": [
      {"name":"...", "out":"Slug-camera.png",
       "b0":1.3, "bForest":1.4, "bElev":0.2,
       "forestMean":0.62,"forestSd":0.15,"elevMean":400,"elevSd":120}
    ]
  }
Prints: {"bounds":[minLng,minLat,maxLng,maxLat],"nx":..,"ny":..,
         "forest":bool,"elevation":bool,"models":[name,...]}
"""
import json
import math
import os
import sys

MAX_DIM = 2200           # display raster safety cap
MAX_NATIVE = 4200         # native read safety cap (per side)
# Colour ramps as lists of RGB stops (interpolated in ramp_rgb). ψ uses a
# plasma-style ramp (purple→magenta→orange→yellow) with NO green, so the
# occupancy surface is never confused with the green forest-cover layer.
RAMPS = {
    "psi": [(13, 8, 135), (126, 3, 168), (204, 71, 120), (248, 149, 64), (240, 249, 33)],
    "forest": [(247, 252, 245), (0, 68, 27)],      # white → deep green
    "elevation": [(255, 255, 204), (140, 45, 4)],  # pale → brown
}


def ramp_rgb(t, stops):
    """Interpolate a normalized field t∈[0,1] through a list of RGB stops."""
    import numpy as np

    arr = np.asarray(stops, dtype=float)  # (K, 3)
    k = len(arr)
    pos = np.clip(t, 0.0, 1.0) * (k - 1)
    idx = np.clip(pos.astype(int), 0, k - 2)
    frac = (pos - idx)[..., None]
    return arr[idx] + (arr[idx + 1] - arr[idx]) * frac  # (..., 3)


def fail(msg):
    print(json.dumps({"error": str(msg)}))
    sys.exit(1)


def load_kml_polygon(path):
    import re
    from shapely.geometry import Polygon

    with open(path, "r", encoding="utf-8") as fh:
        txt = fh.read()
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


def main():
    import numpy as np
    import rasterio
    from rasterio.windows import Window, from_bounds
    from rasterio.enums import Resampling
    from rasterio.warp import transform_bounds
    from rasterio.features import geometry_mask
    from pyproj import Transformer
    from affine import Affine
    from PIL import Image

    cfg = json.loads(sys.stdin.read())
    forest_path = cfg.get("forestRaster")
    if not forest_path:
        fail("forestRaster required")
    dem_path = cfg.get("demRaster")
    forest_classes = list(cfg.get("forestClasses", [1]))
    buffer_m = float(cfg.get("bufferMeters", 500))
    forest_layer_m = float(cfg.get("forestLayerMeters", 60))
    # ψ forest window (radius, m). Defaults to the model's fit buffer (bufferMeters)
    # so the predicted surface is evaluated at the SAME scale the coefficients were
    # fit on — the statistically consistent choice. A smaller override
    # (psiForestMeters) sharpens the surface toward the DEM resolution but drifts
    # off the fitted scale and, for forest-driven species, toward a binary look.
    _pf = cfg.get("psiForestMeters")
    psi_forest_m = float(_pf) if _pf is not None else buffer_m
    display_m = float(cfg.get("displayMeters", 25))
    out_dir = cfg["outDir"]

    poly = load_kml_polygon(cfg["aoiKml"]) if cfg.get("aoiKml") else None
    if poly is None:
        fail("aoiKml polygon required for high-res render")
    w, s, e, n = poly.bounds

    # --- display grid over the AOI bbox (WGS84) ---
    lat0 = math.radians((s + n) / 2.0)
    m_per_deg_lat = 111320.0
    m_per_deg_lng = 111320.0 * max(math.cos(lat0), 1e-6)
    nx = int(min(MAX_DIM, max(2, round((e - w) * m_per_deg_lng / display_m))))
    ny = int(min(MAX_DIM, max(2, round((n - s) * m_per_deg_lat / display_m))))
    dlng = (e - w) / nx
    dlat = (n - s) / ny
    lng_c = w + (np.arange(nx) + 0.5) * dlng
    lat_c = n - (np.arange(ny) + 0.5) * dlat  # row 0 = north
    LNG, LAT = np.meshgrid(lng_c, lat_c)
    display_transform = Affine.translation(w, n) * Affine.scale(dlng, -dlat)

    # inside-polygon mask on the display grid (transparent outside)
    inside = geometry_mask(
        [poly.__geo_interface__], out_shape=(ny, nx),
        transform=display_transform, invert=True,
    )

    pad = buffer_m + 1000.0

    def read_window(path, decimate_to_m):
        with rasterio.open(path) as src:
            crs = src.crs
            left, bottom, right, top = transform_bounds(
                "EPSG:4326", crs, w, s, e, n, densify_pts=21
            )
            win = from_bounds(left - pad, bottom - pad, right + pad, top + pad, src.transform)
            win = win.intersection(Window(0, 0, src.width, src.height))
            native_unit = abs(src.transform.a) or 1.0
            native_m = native_unit * m_per_deg_lat if crs.is_geographic else native_unit
            dec = max(1, int(round(decimate_to_m / native_m)))
            out_h = max(1, min(MAX_NATIVE, int(round(win.height / dec))))
            out_w = max(1, min(MAX_NATIVE, int(round(win.width / dec))))
            arr = src.read(1, window=win, out_shape=(out_h, out_w), resampling=Resampling.nearest)
            wt = src.window_transform(win) * Affine.scale(win.width / out_w, win.height / out_h)
            inv = ~wt
            return {
                "arr": arr, "inv": inv, "nodata": src.nodata,
                "pixel_m": abs(wt.a) if not crs.is_geographic else abs(wt.a) * m_per_deg_lat,
                "tx": Transformer.from_crs("EPSG:4326", crs, always_xy=True),
                "h": out_h, "w": out_w,
            }

    def display_rowcol(win):
        """Native (row,col) integer indices for every display-grid centre."""
        x, y = win["tx"].transform(LNG, LAT)
        inv = win["inv"]
        col = inv.a * x + inv.b * y + inv.c
        row = inv.d * x + inv.e * y + inv.f
        return np.rint(row).astype(np.int64), np.rint(col).astype(np.int64)

    # --- forest: read native mask once, build integral images for box means ---
    # Read at ~forest_layer_m so the fine forest layer keeps detail while the
    # array stays small enough for a 500 m box-mean integral image.
    F = read_window(forest_path, min(forest_layer_m, 15.0))
    fnod = F["nodata"]
    valid_native = np.ones_like(F["arr"], dtype=np.float64) if fnod is None else (F["arr"] != fnod).astype(np.float64)
    forest_native = np.isin(F["arr"], forest_classes).astype(np.float64) * valid_native
    H, W = F["h"], F["w"]
    # padded integral images
    I_forest = np.zeros((H + 1, W + 1))
    I_valid = np.zeros((H + 1, W + 1))
    I_forest[1:, 1:] = np.cumsum(np.cumsum(forest_native, 0), 1)
    I_valid[1:, 1:] = np.cumsum(np.cumsum(valid_native, 0), 1)
    frow, fcol = display_rowcol(F)
    in_native = (frow >= 0) & (frow < H) & (fcol >= 0) & (fcol < W)

    def box_cover(rad_m):
        rad = max(1, int(round(rad_m / F["pixel_m"])))
        r0 = np.clip(frow - rad, 0, H); r1 = np.clip(frow + rad + 1, 0, H)
        c0 = np.clip(fcol - rad, 0, W); c1 = np.clip(fcol + rad + 1, 0, W)
        fsum = I_forest[r1, c1] - I_forest[r0, c1] - I_forest[r1, c0] + I_forest[r0, c0]
        vsum = I_valid[r1, c1] - I_valid[r0, c1] - I_valid[r1, c0] + I_valid[r0, c0]
        cover = np.divide(fsum, vsum, out=np.full(fsum.shape, np.nan), where=vsum > 0)
        cover[~in_native] = np.nan
        return cover

    forest_fine = box_cover(forest_layer_m / 2.0)   # detailed forest layer
    forest_psi = box_cover(psi_forest_m)             # ψ surface (detailed but smooth)

    # --- elevation ---
    elev = None
    if dem_path:
        D = read_window(dem_path, display_m)
        drow, dcol = display_rowcol(D)
        din = (drow >= 0) & (drow < D["h"]) & (dcol >= 0) & (dcol < D["w"])
        elev = np.full((ny, nx), np.nan)
        rr = np.clip(drow, 0, D["h"] - 1); cc = np.clip(dcol, 0, D["w"] - 1)
        vals = D["arr"][rr, cc].astype(np.float64)
        if D["nodata"] is not None:
            vals[vals == D["nodata"]] = np.nan
        vals[~din] = np.nan
        elev = vals

    def colorize(values, ramp, vmin, vmax, valid, out_path):
        stops = RAMPS.get(ramp, RAMPS["psi"])
        if vmax <= vmin:
            vmax = vmin + 1e-9
        t = np.clip((values - vmin) / (vmax - vmin), 0.0, 1.0)
        rgb = ramp_rgb(np.nan_to_num(t, nan=0.0), stops)  # (ny, nx, 3)
        rgba = np.zeros((ny, nx, 4), dtype=np.uint8)
        good = valid & np.isfinite(values)
        for k in range(3):
            rgba[..., k] = np.where(good, rgb[..., k], 0).astype(np.uint8)
        rgba[..., 3] = np.where(good, 255, 0).astype(np.uint8)
        Image.fromarray(rgba, "RGBA").save(os.path.join(out_dir, out_path))

    os.makedirs(out_dir, exist_ok=True)
    did_forest = False
    did_elev = False
    done_models = []

    if cfg.get("forest"):
        colorize(forest_fine, "forest", 0.0, 1.0, inside, cfg["forest"]["out"])
        did_forest = True
    if cfg.get("elevation") and elev is not None:
        fin = elev[np.isfinite(elev) & inside]
        if fin.size:
            colorize(elev, "elevation", float(fin.min()), float(fin.max()), inside, cfg["elevation"]["out"])
            did_elev = True

    for md in cfg.get("models", []):
        # Isolate each model's render: one bad model (degenerate coefficients,
        # all-NA grid) must NOT abort the whole pass and null out EVERY ψ
        # surface — the forest/elevation layers are already written above, so an
        # unguarded raise would leave the page with covariate layers but no ψ.
        try:
            lin = np.full((ny, nx), float(md.get("b0", 0.0)))
            # Evaluate ψ from a finer forest cover than the 500 m fit buffer so the
            # occupancy surface carries fine detail (patches/streams) like the forest
            # and elevation layers instead of a blurred 500 m mosaic — while staying
            # smooth enough to keep a probability gradient. (This is the map's
            # resolution; the coefficient itself was fit at the 500 m buffer scale.)
            valid = inside & np.isfinite(forest_psi)
            bf, fsd = md.get("bForest"), md.get("forestSd")
            if bf is not None and fsd:
                lin = lin + bf * (forest_psi - md.get("forestMean", 0.0)) / fsd
            be, esd = md.get("bElev"), md.get("elevSd")
            if be is not None and esd and elev is not None:
                lin = lin + be * (elev - md.get("elevMean", 0.0)) / esd
                valid = valid & np.isfinite(elev)
            psi = 1.0 / (1.0 + np.exp(-lin))
            colorize(psi, "psi", 0.0, 1.0, valid, md["out"])
            done_models.append(md["name"])
        except Exception as ex:  # noqa: BLE001
            sys.stderr.write(f"psi surface render failed for {md.get('name')!r}: {ex}\n")

    print(json.dumps({
        "bounds": [w, s, e, n],
        "nx": nx, "ny": ny,
        "forest": did_forest, "elevation": did_elev, "models": done_models,
    }))


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as ex:  # noqa: BLE001
        fail(ex)
