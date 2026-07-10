import "server-only";
import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { log } from "@/lib/log";

/**
 * TS bridge to scripts/occupancy-forest-cover.py — spawns the rasterio pipeline,
 * writes ONE JSON config to stdin, parses the NDJSON it streams. Resolves-never-
 * rejects (birdnet-runner shape). Python resolves via OCCUPANCY_PYTHON_PATH →
 * ML_PYTHON_PATH → the bundled ML venv (rasterio/pyproj/shapely live there, U16).
 */

const PY_SCRIPT = path.join(process.cwd(), "scripts", "occupancy-forest-cover.py");

function resolvePython(): string {
  return (
    process.env.OCCUPANCY_PYTHON_PATH ||
    process.env.ML_PYTHON_PATH ||
    path.join(process.cwd(), "data", "ml-venv", "bin", "python3")
  );
}

export interface RasterConfig {
  forestRaster: string;
  demRaster?: string | null;
  aoiKml?: string | null;
  forestClasses?: number[];
  bufferMeters?: number;
  gridCellMeters?: number;
  sites: { siteId: string; lat: number; lng: number }[];
}

export interface RasterSiteResult {
  siteId: string;
  forestCover: number | null;
  elevation: number | null;
}

export interface RasterGridCell {
  lat: number;
  lng: number;
  forestCover: number | null;
  elevation: number | null;
}

export type RasterResult =
  | { success: true; sites: RasterSiteResult[]; grid: RasterGridCell[] }
  | { success: false; error: string };

export interface RasterRunOptions {
  pythonPath?: string;
  scriptPath?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 300_000;

export function runForestCover(
  config: RasterConfig,
  opts: RasterRunOptions = {},
): Promise<RasterResult> {
  const python = opts.pythonPath ?? resolvePython();
  const script = opts.scriptPath ?? PY_SCRIPT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<RasterResult>((resolve) => {
    let sites: RasterSiteResult[] = [];
    let grid: RasterGridCell[] = [];
    let runnerError: string | undefined;
    let settled = false;
    const stderrChunks: string[] = [];

    const proc = spawn(python, [script], { stdio: ["pipe", "pipe", "pipe"] });

    const timer = setTimeout(() => {
      runnerError = `forest-cover timed out after ${timeoutMs}ms`;
      proc.kill("SIGKILL");
    }, timeoutMs);

    const finish = (value: RasterResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    proc.on("error", (err) =>
      finish({ success: false, error: `failed to spawn python (${python}): ${err.message}` }),
    );

    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      const t = line.trim();
      if (!t) return;
      let msg: { type?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(t);
      } catch {
        return;
      }
      if (msg.type === "sites") sites = (msg.sites as RasterSiteResult[]) ?? [];
      else if (msg.type === "grid") grid = (msg.cells as RasterGridCell[]) ?? [];
      else if (msg.type === "error") runnerError = String(msg.message ?? "unknown error");
    });

    const errRl = createInterface({ input: proc.stderr });
    errRl.on("line", (line) => stderrChunks.push(line));

    proc.on("close", (code) => {
      if (stderrChunks.length) log.debug({ stderr: stderrChunks.join("\n") }, "forest_cover_stderr");
      if (runnerError) return finish({ success: false, error: runnerError });
      if (code !== 0 && code !== null) {
        return finish({
          success: false,
          error: `python exited ${code}${stderrChunks.length ? `: ${stderrChunks.slice(-2).join(" ")}` : ""}`,
        });
      }
      finish({ success: true, sites, grid });
    });

    proc.stdin.write(JSON.stringify(config));
    proc.stdin.end();
  });
}
