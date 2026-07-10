import "server-only";
import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { log } from "@/lib/log";

/**
 * TS bridge to `scripts/occupancy-runner.R` — modeled on `birdnet-runner.ts`:
 * spawn a single-shot child, write ONE JSON config to stdin, parse the NDJSON it
 * streams back, resolve with a discriminated result. Like the BirdNET runner this
 * ALWAYS resolves (never rejects) so callers get a clean ActionResult-shaped value.
 *
 * R binary resolution mirrors the ML_PYTHON_PATH convention: an explicit override
 * wins, else `Rscript` on PATH (installed into the image alongside the ML venv).
 */

const R_SCRIPT = path.join(process.cwd(), "scripts", "occupancy-runner.R");

function resolveRscript(): string {
  return process.env.OCCUPANCY_RSCRIPT_PATH || process.env.RSCRIPT_PATH || "Rscript";
}

/** Config contract — must match the shape occupancy-runner.R parses. */
export interface OccupancyRunConfig {
  species: string;
  stream: "camera" | "audio";
  binWidth: number;
  /** sites × occasions detection history; use null for NA cells. */
  y: (0 | 1 | null)[][];
  siteCovs: Record<string, (number | string)[]>;
  siteFactors: string[];
  obsCovs: Record<string, (string | null)[][]>;
  obsFactors: string[];
  psiFormula: string;
  detFormula: string;
  grid?: Record<string, (number | string)[]> | null;
  /** Per continuous covariate {mean, sd} so R can relabel curve x in raw units. */
  standardizations?: Record<string, { mean: number; sd: number }>;
}

export interface OccupancyEffect {
  param: string;
  estimate: number;
  se: number;
  z: number;
  p: number;
}

export interface OccupancyPrediction {
  psi: number[];
  se: number[];
  lower: number[];
  upper: number[];
}

/** Predicted ψ (with 95% CI) at a raw covariate value, for a response curve. */
export interface OccupancyCurvePoint {
  x: number;
  psi: number;
  lower: number;
  upper: number;
}

/** Predicted ψ (with 95% CI) for one habitat factor level. */
export interface OccupancyHabitatBar {
  habitat: string;
  psi: number;
  lower: number;
  upper: number;
  isReference: boolean;
}

export interface OccupancyResult {
  species: string;
  stream: string;
  nSites: number;
  nOccasions: number;
  /** optim convergence code (0 = converged). */
  convergence: number | null;
  aic: number | null;
  fitSeconds: number;
  naiveOccupancy: number;
  estimatedOccupancy: number | null;
  /** 95% interval for the study-area occupancy (mean of per-site bounds). */
  occupancyLower: number | null;
  occupancyUpper: number | null;
  meanDetection: number | null;
  effects: OccupancyEffect[];
  prediction?: OccupancyPrediction;
  predictSeconds?: number;
  /** Response curves keyed by continuous covariate name (e.g. "forest"). */
  curves?: Record<string, OccupancyCurvePoint[]>;
  /** Predicted ψ per habitat level. */
  habitatUse?: OccupancyHabitatBar[];
}

export type OccupancyRunResult =
  | { success: true; version: { unmarked: string; R: string }; result: OccupancyResult }
  | { success: false; error: string };

/** Milliseconds before we give up on a single fit and kill the child. */
const DEFAULT_TIMEOUT_MS = 120_000;

export function runOccupancyModel(
  config: OccupancyRunConfig,
  opts: { timeoutMs?: number } = {},
): Promise<OccupancyRunResult> {
  const rscript = resolveRscript();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<OccupancyRunResult>((resolve) => {
    let version: { unmarked: string; R: string } | undefined;
    let result: OccupancyResult | undefined;
    let runnerError: string | undefined;
    let settled = false;
    const stderrChunks: string[] = [];

    const proc = spawn(rscript, [R_SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });

    const timer = setTimeout(() => {
      runnerError = `occupancy fit timed out after ${timeoutMs}ms`;
      proc.kill("SIGKILL");
    }, timeoutMs);

    const finish = (value: OccupancyRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    proc.on("error", (err) => {
      finish({ success: false, error: `failed to spawn Rscript (${rscript}): ${err.message}` });
    });

    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: { type?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return; // ignore non-JSON noise
      }
      switch (msg.type) {
        case "version":
          version = { unmarked: String(msg.unmarked), R: String(msg.R) };
          break;
        case "result":
          result = msg as unknown as OccupancyResult;
          break;
        case "error":
          runnerError = String(msg.message ?? "unknown R error");
          break;
        // "complete" is a terminal marker; nothing to do.
      }
    });

    const errRl = createInterface({ input: proc.stderr });
    errRl.on("line", (line) => {
      // unmarked emits an expected "obsCovs contains characters" notice — keep at debug.
      stderrChunks.push(line);
    });

    proc.on("close", (code) => {
      if (stderrChunks.length) {
        log.debug({ stderr: stderrChunks.join("\n") }, "occupancy_runner_stderr");
      }
      if (runnerError) {
        finish({ success: false, error: runnerError });
        return;
      }
      if (code !== 0 && code !== null) {
        finish({
          success: false,
          error: `Rscript exited ${code}${stderrChunks.length ? `: ${stderrChunks.slice(-3).join(" ")}` : ""}`,
        });
        return;
      }
      if (!result || !version) {
        finish({ success: false, error: "occupancy runner produced no result" });
        return;
      }
      finish({ success: true, version, result });
    });

    // Feed the config and close stdin so the R side's readLines("stdin") returns.
    proc.stdin.write(JSON.stringify(config));
    proc.stdin.end();
  });
}
