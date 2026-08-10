import "server-only";

/**
 * Shared R interpreter resolution.
 *
 * Mirrors the ML_PYTHON_PATH convention: an explicit override wins, else
 * `Rscript` on PATH (installed into the image alongside the ML venv).
 *
 * `OCCUPANCY_RSCRIPT_PATH` is checked first and kept for compatibility — it is
 * already set in production and predates any second R consumer. `RSCRIPT_PATH`
 * is the name to prefer for new deployments.
 */
export function resolveRscript(): string {
  return process.env.OCCUPANCY_RSCRIPT_PATH || process.env.RSCRIPT_PATH || "Rscript";
}
