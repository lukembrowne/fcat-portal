import "server-only";
import { spawn } from "node:child_process";
import path from "node:path";
import { log } from "@/lib/log";

/**
 * TS bridge to scripts/occupancy-render-surface.py — colorizes a per-cell grid
 * into a transparent PNG for a Leaflet ImageOverlay. Resolves-never-rejects
 * (returns null on any failure) so a render hiccup never fails a whole run.
 * Python resolves via OCCUPANCY_PYTHON_PATH → ML_PYTHON_PATH → the bundled venv.
 */

const PY_SCRIPT = path.join(process.cwd(), "scripts", "occupancy-render-surface.py");
const RASTER_SCRIPT = path.join(process.cwd(), "scripts", "occupancy-render-raster.py");

function resolvePython(): string {
  return (
    process.env.OCCUPANCY_PYTHON_PATH ||
    process.env.ML_PYTHON_PATH ||
    path.join(process.cwd(), "data", "ml-venv", "bin", "python3")
  );
}

export interface SurfaceCell {
  lat: number;
  lng: number;
  value: number | null;
}

/**
 * Cell-edge extent `[minLng, minLat, maxLng, maxLat]` — a fallback used only if
 * the render script doesn't return bounds. Mirrors the render script's
 * aspect-ratio dimension estimate (the grid is stepped in UTM then reprojected,
 * so coordinate gaps are unreliable) and pads by half a cell.
 */
export function paddedBbox(cells: { lat: number; lng: number }[]): number[] | null {
  if (cells.length === 0) return null;
  const lats = cells.map((c) => c.lat);
  const lngs = cells.map((c) => c.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const rlat = maxLat - minLat || 1e-9;
  const rlng = maxLng - minLng || 1e-9;
  const ny = Math.max(1, Math.round(Math.sqrt(cells.length / (rlng / rlat))));
  const nx = Math.max(1, Math.round(cells.length / ny));
  const dlat = nx > 1 ? rlat / (ny - 1 || 1) : rlat;
  const dlng = nx > 1 ? rlng / (nx - 1 || 1) : rlng;
  return [minLng - dlng / 2, minLat - dlat / 2, maxLng + dlng / 2, maxLat + dlat / 2];
}

export interface RenderSurfaceResult {
  bounds: [number, number, number, number];
  nx: number;
  ny: number;
  vmin: number;
  vmax: number;
}

export function renderSurface(
  opts: {
    cells: SurfaceCell[];
    ramp: "psi" | "forest" | "elevation";
    outPath: string;
    vmin?: number;
    vmax?: number;
  },
  runOpts: { pythonPath?: string; timeoutMs?: number } = {},
): Promise<RenderSurfaceResult | null> {
  const python = runOpts.pythonPath ?? resolvePython();
  const timeoutMs = runOpts.timeoutMs ?? 60_000;

  return new Promise<RenderSurfaceResult | null>((resolve) => {
    let out = "";
    let settled = false;
    const errChunks: string[] = [];
    const proc = spawn(python, [PY_SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });

    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    const finish = (v: RenderSurfaceResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };

    proc.on("error", (e) => {
      log.warn({ err: e.message }, "occupancy_surface_spawn_failed");
      finish(null);
    });
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => errChunks.push(d.toString()));

    proc.on("close", (code) => {
      if (code !== 0 && code !== null) {
        log.warn({ code, stderr: errChunks.join("").slice(-400) }, "occupancy_surface_failed");
        return finish(null);
      }
      try {
        const line = out.trim().split("\n").filter(Boolean).pop() ?? "";
        const parsed = JSON.parse(line);
        if (parsed?.error || !Array.isArray(parsed?.bounds)) return finish(null);
        finish(parsed as RenderSurfaceResult);
      } catch {
        finish(null);
      }
    });

    proc.stdin.write(
      JSON.stringify({
        cells: opts.cells,
        ramp: opts.ramp,
        out: opts.outPath,
        vmin: opts.vmin,
        vmax: opts.vmax,
      }),
    );
    proc.stdin.end();
  });
}

/** Per-model ψ-surface spec: the fitted state coefficients + the standardization
 *  params the model saw, so the renderer can evaluate ψ per raster pixel. */
export interface RasterModelSpec {
  name: string;
  out: string;
  b0: number;
  bForest: number | null;
  bElev: number | null;
  forestMean?: number;
  forestSd?: number;
  elevMean?: number;
  elevSd?: number;
}

export interface RenderRasterResult {
  bounds: [number, number, number, number];
  nx: number;
  ny: number;
  forest: boolean;
  elevation: boolean;
  models: string[];
}

/**
 * TS bridge to scripts/occupancy-render-raster.py — renders the crisp forest /
 * elevation covariate layers AND every per-model ψ surface in ONE pass (the
 * native raster read happens once). Resolves-never-rejects (null on any failure).
 */
export function renderRasterSurfaces(
  opts: {
    forestRaster: string;
    demRaster: string | null;
    forestClasses?: number[];
    bufferMeters?: number;
    forestLayerMeters?: number;
    psiForestMeters?: number;
    displayMeters?: number;
    aoiKml: string;
    outDir: string;
    forest?: { out: string };
    elevation?: { out: string };
    models: RasterModelSpec[];
  },
  runOpts: { pythonPath?: string; timeoutMs?: number } = {},
): Promise<RenderRasterResult | null> {
  const python = runOpts.pythonPath ?? resolvePython();
  const timeoutMs = runOpts.timeoutMs ?? 180_000;

  return new Promise<RenderRasterResult | null>((resolve) => {
    let out = "";
    let settled = false;
    const errChunks: string[] = [];
    const proc = spawn(python, [RASTER_SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    const finish = (v: RenderRasterResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    proc.on("error", (err) => {
      log.warn({ err: err.message }, "occupancy_raster_render_spawn_failed");
      finish(null);
    });
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => errChunks.push(d.toString()));
    proc.on("close", (code) => {
      if (code !== 0 && code !== null) {
        log.warn({ code, stderr: errChunks.join("").slice(-500) }, "occupancy_raster_render_failed");
        return finish(null);
      }
      try {
        const line = out.trim().split("\n").filter(Boolean).pop() ?? "";
        const parsed = JSON.parse(line);
        if (parsed?.error || !Array.isArray(parsed?.bounds)) return finish(null);
        finish(parsed as RenderRasterResult);
      } catch {
        finish(null);
      }
    });
    proc.stdin.write(
      JSON.stringify({
        forestRaster: opts.forestRaster,
        demRaster: opts.demRaster,
        forestClasses: opts.forestClasses,
        bufferMeters: opts.bufferMeters,
        forestLayerMeters: opts.forestLayerMeters,
        psiForestMeters: opts.psiForestMeters,
        displayMeters: opts.displayMeters,
        aoiKml: opts.aoiKml,
        outDir: opts.outDir,
        forest: opts.forest,
        elevation: opts.elevation,
        models: opts.models,
      }),
    );
    proc.stdin.end();
  });
}
