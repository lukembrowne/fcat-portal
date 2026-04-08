/**
 * Pure helpers for the camera trap training-dataset exporter.
 *
 * Kept in a separate, server-only file (not actions.ts) so they can be
 * unit-tested without the "use server" constraint that all exports be async.
 *
 * No DB, no filesystem, no Drive — just functions over plain values.
 */

import crypto from "node:crypto";

export type Split = "train" | "val" | "test";

/**
 * Bumping this constant deliberately invalidates every previous content hash.
 * Change it only if the split-assignment algorithm itself changes.
 */
export const SPLIT_STRATEGY_VERSION = 1;

/**
 * Deterministically assign a deployment to a train/val/test split using a
 * hash bucket. 0–69 train, 70–84 val, 85–99 test (70/15/15).
 *
 * Pure: same deploymentId always returns the same split. Used for new
 * deployments only — existing deployment splits in the DB are write-once.
 */
export function assignSplit(deploymentId: number): Split {
  const hash = crypto
    .createHash("sha256")
    .update(String(deploymentId))
    .digest("hex");
  // Take the first 4 hex chars (16 bits) as an unsigned int, mod 100.
  const bucket = parseInt(hash.slice(0, 4), 16) % 100;
  if (bucket < 70) return "train";
  if (bucket < 85) return "val";
  return "test";
}

/**
 * Convert a free-form species label into a filesystem-safe slug.
 *
 * The same slug must be produced by:
 *   - the exporter (for the on-disk crop directory)
 *   - the manifest (classList entries)
 *   - the registered model's class_mapping.json
 *
 * Drift here = silent training failure, so the rules are deliberate and tested.
 */
export function speciesSlug(label: string): string {
  return label
    .normalize("NFD")
    // Strip combining diacritics (é → e, ñ → n).
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    // Collapse any run of non-alphanumeric chars into a single underscore.
    .replace(/[^a-z0-9]+/g, "_")
    // No leading/trailing underscores.
    .replace(/^_+|_+$/g, "");
}

/**
 * Row shape fed into the content hash. Tuple form keeps the canonical
 * representation small.
 */
export interface HashRow {
  imageId: number;
  finalLabel: string;
  deploymentId: number;
  split: Split;
}

/**
 * Compute a deterministic SHA-256 over the canonical exporter inputs.
 *
 * JSON serialization (not pipe-joined) so user-typed `correctedSpecies`
 * containing `|` cannot collide with another label. Includes
 * SPLIT_STRATEGY_VERSION so any future change to split assignment
 * deliberately invalidates old hashes.
 */
export function computeContentHash(input: {
  rows: HashRow[];
  minExamples: number;
  classList: string[];
}): string {
  const sortedRows = [...input.rows]
    .sort((a, b) => a.imageId - b.imageId)
    .map((r) => [r.imageId, r.finalLabel, r.deploymentId, r.split]);
  const canonical = JSON.stringify({
    splitStrategyVersion: SPLIT_STRATEGY_VERSION,
    minExamples: input.minExamples,
    classList: [...input.classList].sort(),
    rows: sortedRows,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * Manifest counts: total + per-split + per-class-per-split.
 */
export interface ManifestCounts {
  total: number;
  train: number;
  val: number;
  test: number;
  perClass: Record<string, { train: number; val: number; test: number }>;
}

/**
 * Aggregate per-class-per-split counts from a row list. Used both for the
 * manifest and for sanity-checking the export.
 */
export function buildCounts(
  rows: Array<{ finalLabel: string; split: Split }>,
): ManifestCounts {
  const counts: ManifestCounts = {
    total: rows.length,
    train: 0,
    val: 0,
    test: 0,
    perClass: {},
  };
  for (const row of rows) {
    counts[row.split] += 1;
    const slug = speciesSlug(row.finalLabel);
    if (!counts.perClass[slug]) {
      counts.perClass[slug] = { train: 0, val: 0, test: 0 };
    }
    counts.perClass[slug][row.split] += 1;
  }
  return counts;
}

/**
 * Build the slim manifest (no per-image array — the filesystem layout is
 * the index for that). Pure function over the inputs the exporter has
 * already prepared.
 */
export function buildManifest(input: {
  version: string;
  contentHash: string;
  createdAt: Date;
  createdBy: string;
  minExamplesThreshold: number;
  classList: string[];
  droppedSpecies: Record<string, number>;
  counts: ManifestCounts;
  deployments: Array<{ id: number; split: Split; imageCount: number }>;
  warnings: string[];
}): Record<string, unknown> {
  return {
    version: input.version,
    contentHash: `sha256:${input.contentHash}`,
    createdAt: input.createdAt.toISOString(),
    createdBy: input.createdBy,
    splitStrategyVersion: SPLIT_STRATEGY_VERSION,
    minExamplesThreshold: input.minExamplesThreshold,
    classList: input.classList,
    droppedSpecies: input.droppedSpecies,
    counts: input.counts,
    deployments: input.deployments,
    warnings: input.warnings,
  };
}
