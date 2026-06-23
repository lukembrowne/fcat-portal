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

/**
 * Minimum distinct deployments a species needs for the stratifier to attempt
 * 1/1/1 rebalancing. Also reused by the exporter as the per-class inclusion
 * threshold: classes with fewer distinct deployments are dropped into
 * `droppedSpecies` before the stratifier runs.
 *
 * These two roles must stay equal. If inclusion ever drifts below the
 * stratifier threshold, the exporter would silently ship manifests with
 * val=0 or test=0 for low-deployment classes — the v1 livestock bug
 * (see docs/plans/2026-05-19-fix-training-export-guarantee-val-test-coverage-plan.md).
 */
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
 * Pre-stratify inclusion filter. A class is included in the export iff it
 * has BOTH enough total examples AND enough distinct deployments. The
 * deployment threshold equals STRATIFY_MIN_DEPLOYMENTS by design — classes
 * below it cannot be balanced into train+val+test no matter how many
 * examples they have (a single camera cannot occupy three splits).
 *
 * Returns surviving labels (sorted) and a flat label→totalCount drop map.
 * Both reasons (below-examples and below-deployments) collapse into the
 * same drop map because the manifest consumer doesn't care why a class
 * didn't qualify, only that it didn't. The portal UI surfaces the
 * distinction by displaying the deployment count alongside the example
 * count for each dropped entry.
 */
export function selectIncludedClasses(input: {
  labelCounts: Map<string, number>;
  labelDeployments: Map<string, Set<number>>;
  minExamples: number;
  minDeployments: number;
}): { classList: string[]; droppedSpecies: Record<string, number> } {
  const classList: string[] = [];
  const droppedSpecies: Record<string, number> = {};
  for (const [label, count] of input.labelCounts) {
    const deps = input.labelDeployments.get(label)?.size ?? 0;
    if (count >= input.minExamples && deps >= input.minDeployments) {
      classList.push(label);
    } else {
      droppedSpecies[label] = count;
    }
  }
  classList.sort();
  return { classList, droppedSpecies };
}

/**
 * Post-stratify safety check: given the final per-label per-split counts,
 * return the set of labels that still have zero examples in train, val, or
 * test. After the deployment-count pre-filter this should only trigger in
 * the edge case where 3+ deployments are anchored to the same split from a
 * prior export and the stratifier could not rebalance them. Returns labels
 * sorted for deterministic surfacing.
 */
export function findUncoveredLabels(
  perLabelSplitCounts: Map<string, { train: number; val: number; test: number }>,
): string[] {
  const uncovered: string[] = [];
  for (const [label, counts] of perLabelSplitCounts) {
    if (counts.train === 0 || counts.val === 0 || counts.test === 0) {
      uncovered.push(label);
    }
  }
  uncovered.sort((a, b) => a.localeCompare(b, "es"));
  return uncovered;
}

/**
 * Convert a free-form species label into a filesystem-safe slug.
 *
 * Legacy: produced the on-disk folder names and manifest classList entries
 * for training datasets shipped before 2026-05. Models trained on those
 * exports output slug strings at inference time and do NOT link to the
 * canonical biochoco_species table without re-training. Retained because
 * it is still useful elsewhere and because content-hash code may need to
 * reproduce historical slugs.
 *
 * For new exports use speciesFolderName below.
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
 * Folder-safe but human-readable rendering of a species name for the
 * training dataset.
 *
 * Preserves spaces and diacritics so the on-disk folder name IS the
 * canonical biochoco_species.scientificName. PyTorch ImageFolder reads
 * folder names directly as class names, so class_mapping.json (and
 * therefore inference output) will match the species table exactly,
 * letting the English/Spanish toggle and species aggregations work
 * natively for re-classified detections.
 *
 * Only strips characters that genuinely break filesystem tooling.
 */
export function speciesFolderName(label: string): string {
  return (
    label
      // Canonical Unicode form so the bytes on disk match the bytes in the
      // species table (most stored strings are already NFC).
      .normalize("NFC")
      // Path separators must never appear in a folder name.
      .replace(/[/\\]/g, " ")
      // Strip control chars / NUL / DEL, but keep \t \n \r so the next step
      // can collapse them into normal spaces. (If we stripped them outright,
      // "Panthera\nonca" would become "Pantheraonca".)
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
      // Collapse internal whitespace runs.
      .replace(/\s+/g, " ")
      .trim()
      // A leading dot would make the folder hidden on Unix; never start with one.
      .replace(/^\.+/, "")
      // Generous cap that protects older filesystems (ext4 limit is 255 bytes).
      .slice(0, 200)
  );
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
 * Crop-quality knobs that change the bytes of the exported crops (or which
 * detections qualify) without changing the corpus rows. They MUST feed the
 * content hash — otherwise two exports differing only in padding/quality/floor
 * dedupe to `status: "unchanged"` and the second silently returns the first's
 * crops. See computeContentHash.
 */
export interface QualityParams {
  /** Minimum MegaDetector confidence a detection needs to be exported.
   * Floor is 0.1 — detections below the 0.1 capture threshold are not stored. */
  detectionConfidenceFloor: number;
  /** Fraction of each bbox dimension added as padding before cropping. */
  cropPadding: number;
  /** Long-edge pixel size the crop is resized to. */
  cropLongEdge: number;
  /** JPEG quality (1–100) of the written crop. */
  jpegQuality: number;
}

/**
 * Compute a deterministic SHA-256 over the canonical exporter inputs.
 *
 * JSON serialization (not pipe-joined) so user-typed `correctedSpecies`
 * containing `|` cannot collide with another label. Includes
 * SPLIT_STRATEGY_VERSION so any future change to split assignment
 * deliberately invalidates old hashes.
 *
 * The `quality` block makes crop-quality variants distinct exports: changing
 * padding/long-edge/JPEG-quality (which don't alter `rows`) still yields a new
 * hash and therefore a new version. Adding this block changes every prior
 * hash's basis — the first export after this ships re-creates the dataset
 * under a new version even if the corpus is unchanged (a one-time, harmless
 * re-export).
 */
export function computeContentHash(input: {
  rows: HashRow[];
  minExamples: number;
  classList: string[];
  quality: QualityParams;
}): string {
  const sortedRows = [...input.rows]
    .sort((a, b) => a.imageId - b.imageId)
    .map((r) => [r.imageId, r.finalLabel, r.deploymentId, r.split]);
  const canonical = JSON.stringify({
    splitStrategyVersion: SPLIT_STRATEGY_VERSION,
    minExamples: input.minExamples,
    classList: [...input.classList].sort(),
    quality: {
      detectionConfidenceFloor: input.quality.detectionConfidenceFloor,
      cropPadding: input.quality.cropPadding,
      cropLongEdge: input.quality.cropLongEdge,
      jpegQuality: input.quality.jpegQuality,
    },
    rows: sortedRows,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

// ---------------------------------------------------------------------------
// Per-crop metadata CSV (crops.csv)
// ---------------------------------------------------------------------------

/** One row of crops.csv — the provenance of a single exported crop. */
export interface CropCsvRow {
  /** Path relative to the version dir, e.g. "train/Panthera onca/12345.jpg". */
  cropPath: string;
  detectionId: number;
  imageId: number;
  deploymentId: number;
  deploymentName: string;
  split: Split;
  /** The training label == folder name (correctedSpecies ?? species). */
  label: string;
  /** Raw classifier prediction (may differ from label when corrected). */
  mlSpecies: string | null;
  correctedSpecies: string | null;
  verificationStatus: string;
  /** MegaDetector confidence for this detection (the per-crop score). */
  mdConfidence: number | null;
  /** Species-classifier confidence for this detection. */
  classifierConfidence: number | null;
  /** Normalized bbox (0–1), pre-padding — as stored on the detection. */
  bboxX: number;
  bboxY: number;
  bboxWidth: number;
  bboxHeight: number;
  detectionClass: number;
  /** Detector model version, e.g. "MDV6-yolov9-c" or "manual". */
  detectorModelVersion: string | null;
}

/** Stable column order for crops.csv. */
export const CROPS_CSV_COLUMNS = [
  "crop_path",
  "detection_id",
  "image_id",
  "deployment_id",
  "deployment_name",
  "split",
  "label",
  "ml_species",
  "corrected_species",
  "verification_status",
  "md_confidence",
  "classifier_confidence",
  "bbox_x",
  "bbox_y",
  "bbox_width",
  "bbox_height",
  "detection_class",
  "detector_model_version",
  "crop_padding",
  "crop_long_edge",
  "jpeg_quality",
] as const;

/** RFC-4180 field quoting: quote when the value contains comma, quote, CR or
 * LF; double any embedded quotes. null/undefined render as an empty field. */
export function toCsvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Build the full crops.csv text (header + one row per exported crop). The
 * export-level quality params are denormalized onto every row so the file
 * loads standalone into pandas without joining the manifest.
 */
export function buildCropsCsv(
  rows: CropCsvRow[],
  params: { cropPadding: number; cropLongEdge: number; jpegQuality: number },
): string {
  const lines: string[] = [CROPS_CSV_COLUMNS.join(",")];
  for (const r of rows) {
    lines.push(
      [
        toCsvField(r.cropPath),
        toCsvField(r.detectionId),
        toCsvField(r.imageId),
        toCsvField(r.deploymentId),
        toCsvField(r.deploymentName),
        toCsvField(r.split),
        toCsvField(r.label),
        toCsvField(r.mlSpecies),
        toCsvField(r.correctedSpecies),
        toCsvField(r.verificationStatus),
        toCsvField(r.mdConfidence),
        toCsvField(r.classifierConfidence),
        toCsvField(r.bboxX),
        toCsvField(r.bboxY),
        toCsvField(r.bboxWidth),
        toCsvField(r.bboxHeight),
        toCsvField(r.detectionClass),
        toCsvField(r.detectorModelVersion),
        toCsvField(params.cropPadding),
        toCsvField(params.cropLongEdge),
        toCsvField(params.jpegQuality),
      ].join(","),
    );
  }
  // Trailing newline so the file ends cleanly (POSIX text-file convention).
  return lines.join("\n") + "\n";
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
    // Key by the same folder name the exporter writes to disk, so the
    // manifest's perClass map matches the dataset's directory structure.
    const className = speciesFolderName(row.finalLabel);
    if (!counts.perClass[className]) {
      counts.perClass[className] = { train: 0, val: 0, test: 0 };
    }
    counts.perClass[className][row.split] += 1;
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
  /** Detector + crop-quality provenance for downstream ML consumers. */
  pipeline: {
    detectorModel: string;
    /** Effective MegaDetector confidence floor applied for this export. */
    detectionConfidenceFloor: number;
    /** Capture-time threshold below which detections were never stored. */
    detectionThresholdAtCapture: number;
    cropPadding: number;
    cropLongEdge: number;
    jpegQuality: number;
  };
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
    // Provenance: which detector, threshold, and crop knobs produced these
    // crops — so a collaborator can correlate crop quality with results.
    pipeline: {
      detector: {
        model: input.pipeline.detectorModel,
        library: "PytorchWildlife/MegaDetectorV6",
      },
      detectionConfidenceFloor: input.pipeline.detectionConfidenceFloor,
      detectionThresholdAtCapture: input.pipeline.detectionThresholdAtCapture,
      cropPadding: input.pipeline.cropPadding,
      cropLongEdge: input.pipeline.cropLongEdge,
      jpegQuality: input.pipeline.jpegQuality,
    },
    cropsCsv: "crops.csv",
  };
}

/** Per-split + total counts, used for both baseline snapshots and deltas. */
export interface SplitTotals {
  train: number;
  val: number;
  test: number;
  total: number;
}

/**
 * One display row of the preview's per-species delta table: the current
 * (candidate) counts for a class, plus how they compare to the most recent
 * completed export. `delta`/`baseline` are null when there is no baseline to
 * compare against (first export ever, or the baseline manifest was
 * unreadable). `status` distinguishes a class that is new this time, gone
 * since last time (a "ghost" row, all-zero current), or merely changed.
 */
export interface PreviewDeltaRow {
  label: string;
  folderName: string;
  train: number;
  val: number;
  test: number;
  total: number;
  trainDeployments: number;
  valDeployments: number;
  testDeployments: number;
  trainDeploymentNames: string[];
  valDeploymentNames: string[];
  testDeploymentNames: string[];
  baseline: SplitTotals | null;
  delta: SplitTotals | null;
  status: "changed" | "new" | "removed";
}

export interface PreviewDeltaResult {
  rows: PreviewDeltaRow[];
  /** Footer deltas (current totals − baseline totals). Null when there is no
   * baseline. Equals the sum of the body row deltas because removed classes
   * are included as ghost rows. */
  footer: SplitTotals | null;
}

/** Minimal current-preview row shape consumed by {@link buildPreviewDeltas}.
 * `ExportPreviewSpeciesRow` is structurally compatible. */
export interface PreviewSpeciesCounts {
  label: string;
  folderName: string;
  train: number;
  val: number;
  test: number;
  total: number;
  trainDeployments: number;
  valDeployments: number;
  testDeployments: number;
  trainDeploymentNames: string[];
  valDeploymentNames: string[];
  testDeploymentNames: string[];
}

function mergeDeploymentNames(a: string[], b: string[]): string[] {
  return Array.from(new Set([...a, ...b])).sort((x, y) =>
    x.localeCompare(y, "es"),
  );
}

/**
 * Merge the current preview's per-species rows with a baseline export's
 * per-class-per-split counts (from a manifest's `counts.perClass`), keyed by
 * the on-disk folder name. Pure — no DB/FS.
 *
 * - Current rows are aggregated by folder name first, so two labels that
 *   normalize to the same folder never double-count or mis-key.
 * - A class present now but absent in the baseline is `status:"new"` (its
 *   delta equals its full current count).
 * - A class present in the baseline but absent now becomes a `status:"removed"`
 *   ghost row (all-zero current, negative deltas) so removals are visible and
 *   the footer reconciles with the body.
 * - Per-split deltas are computed independently; a split missing from the
 *   baseline counts as 0 (never NaN).
 * - When `baseline` is null, rows carry the current counts with null
 *   deltas/baseline and `footer` is null (caller suppresses the delta column).
 */
export function buildPreviewDeltas(
  perSpecies: PreviewSpeciesCounts[],
  baseline: ManifestCounts | null,
): PreviewDeltaResult {
  // 1. Aggregate current rows by folder name (defensive against collisions).
  const byFolder = new Map<string, PreviewSpeciesCounts>();
  for (const row of perSpecies) {
    const existing = byFolder.get(row.folderName);
    if (!existing) {
      byFolder.set(row.folderName, { ...row });
      continue;
    }
    existing.train += row.train;
    existing.val += row.val;
    existing.test += row.test;
    existing.total += row.total;
    existing.trainDeploymentNames = mergeDeploymentNames(
      existing.trainDeploymentNames,
      row.trainDeploymentNames,
    );
    existing.valDeploymentNames = mergeDeploymentNames(
      existing.valDeploymentNames,
      row.valDeploymentNames,
    );
    existing.testDeploymentNames = mergeDeploymentNames(
      existing.testDeploymentNames,
      row.testDeploymentNames,
    );
    existing.trainDeployments = existing.trainDeploymentNames.length;
    existing.valDeployments = existing.valDeploymentNames.length;
    existing.testDeployments = existing.testDeploymentNames.length;
  }

  const rows: PreviewDeltaRow[] = [];
  // Track baseline folders so leftovers become "removed" ghost rows.
  const remainingBaseline = new Set<string>(
    baseline ? Object.keys(baseline.perClass) : [],
  );

  for (const [folderName, cur] of byFolder) {
    const base = baseline?.perClass[folderName];
    remainingBaseline.delete(folderName);
    const baseTotals: SplitTotals | null = baseline
      ? {
          train: base?.train ?? 0,
          val: base?.val ?? 0,
          test: base?.test ?? 0,
          total: (base?.train ?? 0) + (base?.val ?? 0) + (base?.test ?? 0),
        }
      : null;
    rows.push({
      ...cur,
      baseline: baseTotals,
      delta: baseTotals
        ? {
            train: cur.train - baseTotals.train,
            val: cur.val - baseTotals.val,
            test: cur.test - baseTotals.test,
            total: cur.total - baseTotals.total,
          }
        : null,
      status: !baseline ? "changed" : base ? "changed" : "new",
    });
  }

  // 2. Ghost rows for baseline-only classes (removed since last export).
  if (baseline) {
    for (const folderName of remainingBaseline) {
      const base = baseline.perClass[folderName];
      const baseTotal = base.train + base.val + base.test;
      rows.push({
        label: folderName,
        folderName,
        train: 0,
        val: 0,
        test: 0,
        total: 0,
        trainDeployments: 0,
        valDeployments: 0,
        testDeployments: 0,
        trainDeploymentNames: [],
        valDeploymentNames: [],
        testDeploymentNames: [],
        baseline: {
          train: base.train,
          val: base.val,
          test: base.test,
          total: baseTotal,
        },
        delta: {
          train: -base.train,
          val: -base.val,
          test: -base.test,
          total: -baseTotal,
        },
        status: "removed",
      });
    }
  }

  if (!baseline) return { rows, footer: null };

  // Footer = current totals − baseline totals (== sum of body deltas, since
  // ghost rows cover every baseline-only class).
  let curTrain = 0;
  let curVal = 0;
  let curTest = 0;
  for (const row of perSpecies) {
    curTrain += row.train;
    curVal += row.val;
    curTest += row.test;
  }
  const curTotal = curTrain + curVal + curTest;
  return {
    rows,
    footer: {
      train: curTrain - baseline.train,
      val: curVal - baseline.val,
      test: curTest - baseline.test,
      total: curTotal - baseline.total,
    },
  };
}
