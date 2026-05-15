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
 *
 * v2 (2026-05): adds per-species deployment coverage guarantee via
 * stratifyDeploymentSplits. Species with >=3 deployments are forced to have
 * at least 1 train, 1 val, 1 test deployment; species with fewer keep their
 * raw hash-bucket assignment.
 */
export const SPLIT_STRATEGY_VERSION = 2;

/**
 * Deterministically assign a deployment to a train/val/test split using a
 * hash bucket. 0–69 train, 70–84 val, 85–99 test (70/15/15).
 *
 * Pure: same deploymentId always returns the same split. Used as the seed
 * for stratifyDeploymentSplits — rare-species coverage rules may override
 * the hash result for specific deployments.
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

/** Minimum total deployments a species needs before stratification kicks in. */
export const STRATIFY_MIN_DEPLOYMENTS = 3;

export interface StratifyInput {
  /** Every deployment that will appear in the export. */
  deploymentIds: number[];
  /** Species (final label) seen on each deployment. */
  speciesByDeployment: Map<number, Set<string>>;
  /** Already-persisted splits — these deployments will not be moved. */
  anchored: Map<number, Split>;
}

export interface ForcedReassignment {
  label: string;
  deploymentId: number;
  from: Split;
  to: Split;
}

export interface StratifyWarning {
  label: string;
  reason: string;
}

export interface StratifyResult {
  splitByDeployment: Map<number, Split>;
  forcedReassignments: ForcedReassignment[];
  warnings: StratifyWarning[];
}

/**
 * Stratify train/val/test assignments so every species with at least
 * STRATIFY_MIN_DEPLOYMENTS deployments has at least one in each split.
 *
 * Algorithm — fully deterministic, no randomness:
 *   1. Seed every deployment with its anchored split if any, else assignSplit().
 *   2. Walk species rarest-first (locale tiebreak on label).
 *   3. For each species with >= STRATIFY_MIN_DEPLOYMENTS, ensure non-empty
 *      val and test. If empty, donate a deployment from a fuller split.
 *   4. Donors must NOT be anchored. Prefer donors whose other species would
 *      keep coverage in their current split after the move. Tiebreak by
 *      deployment id asc.
 *
 * Returns the final assignment, the list of forced moves (for UI surfacing),
 * and warnings for species the stratifier could not help.
 */
export function stratifyDeploymentSplits(
  input: StratifyInput,
): StratifyResult {
  const { deploymentIds, speciesByDeployment, anchored } = input;

  const out = new Map<number, Split>();
  for (const id of deploymentIds) {
    out.set(id, anchored.get(id) ?? assignSplit(id));
  }

  // Inverse map: species -> sorted deployment ids.
  const deploymentsBySpecies = new Map<string, number[]>();
  for (const [depId, speciesSet] of speciesByDeployment) {
    for (const species of speciesSet) {
      if (!deploymentsBySpecies.has(species)) {
        deploymentsBySpecies.set(species, []);
      }
      deploymentsBySpecies.get(species)!.push(depId);
    }
  }
  for (const arr of deploymentsBySpecies.values()) {
    arr.sort((a, b) => a - b);
  }

  // Rarest species first; tiebreak by label.
  const speciesByRarity = Array.from(deploymentsBySpecies.entries()).sort(
    (a, b) => {
      if (a[1].length !== b[1].length) return a[1].length - b[1].length;
      return a[0].localeCompare(b[0], "es");
    },
  );

  const forcedReassignments: ForcedReassignment[] = [];
  const warnings: StratifyWarning[] = [];

  for (const [species, depsForSpecies] of speciesByRarity) {
    if (depsForSpecies.length < STRATIFY_MIN_DEPLOYMENTS) continue;

    const groups = (): Record<Split, number[]> => {
      const g: Record<Split, number[]> = { train: [], val: [], test: [] };
      for (const id of depsForSpecies) g[out.get(id)!].push(id);
      return g;
    };

    const pickDonor = (
      candidates: number[],
      donorSplit: Split,
    ): number | null => {
      // Filter out anchored deployments — they must not move.
      const movable = candidates.filter((id) => !anchored.has(id));
      if (movable.length === 0) return null;
      // Prefer donors whose removal does not leave another species'
      // donorSplit empty. Score = number of other species on this deployment
      // for which the donor's current split would become empty after move.
      const scored = movable.map((id) => {
        let collateral = 0;
        const others = speciesByDeployment.get(id) ?? new Set<string>();
        for (const otherSpecies of others) {
          if (otherSpecies === species) continue;
          const otherDeps = deploymentsBySpecies.get(otherSpecies) ?? [];
          // Count how many of otherSpecies' deployments are currently in donorSplit.
          let inDonor = 0;
          for (const od of otherDeps) {
            if (out.get(od) === donorSplit) inDonor += 1;
          }
          // If only this deployment provides donorSplit coverage for otherSpecies
          // AND otherSpecies has >= STRATIFY_MIN_DEPLOYMENTS, moving creates a violation.
          if (
            inDonor === 1 &&
            otherDeps.length >= STRATIFY_MIN_DEPLOYMENTS
          ) {
            collateral += 1;
          }
        }
        return { id, collateral };
      });
      scored.sort((a, b) => {
        if (a.collateral !== b.collateral) return a.collateral - b.collateral;
        return a.id - b.id;
      });
      return scored[0].id;
    };

    // Fix empty val.
    let g = groups();
    if (g.val.length === 0) {
      const donorPool = g.train.length > 0 ? g.train : g.test;
      const donorSplit: Split = g.train.length > 0 ? "train" : "test";
      const donor = pickDonor(donorPool, donorSplit);
      if (donor !== null) {
        out.set(donor, "val");
        forcedReassignments.push({
          label: species,
          deploymentId: donor,
          from: donorSplit,
          to: "val",
        });
      } else {
        warnings.push({
          label: species,
          reason:
            "Sin val: todas las instalaciones disponibles están ancladas o moverlas crearía una violación en otra especie.",
        });
      }
    }

    // Fix empty test.
    g = groups();
    if (g.test.length === 0) {
      const donorPool = g.train.length > 0 ? g.train : g.val;
      const donorSplit: Split = g.train.length > 0 ? "train" : "val";
      const donor = pickDonor(donorPool, donorSplit);
      if (donor !== null) {
        out.set(donor, "test");
        forcedReassignments.push({
          label: species,
          deploymentId: donor,
          from: donorSplit,
          to: "test",
        });
      } else {
        warnings.push({
          label: species,
          reason:
            "Sin test: todas las instalaciones disponibles están ancladas o moverlas crearía una violación en otra especie.",
        });
      }
    }
  }

  // Sort outputs for deterministic surfacing.
  forcedReassignments.sort((a, b) => {
    if (a.label !== b.label) return a.label.localeCompare(b.label, "es");
    return a.deploymentId - b.deploymentId;
  });
  warnings.sort((a, b) => a.label.localeCompare(b.label, "es"));

  return { splitByDeployment: out, forcedReassignments, warnings };
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
