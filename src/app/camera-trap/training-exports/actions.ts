"use server";

/**
 * Camera trap training-dataset exporter.
 *
 * Produces a versioned, reproducible training dataset on disk under
 * data/training-exports/<version>/ and records the dataset metadata in
 * camera_trap_training_datasets. Pure helpers live in
 * src/lib/training-export-helpers.ts so they can be unit-tested without the
 * "use server" async-export constraint.
 *
 * V1 deviation from the plan: runs synchronously in the server action and
 * does NOT create a processing_jobs row. processing_jobs.deployment_id is
 * NOT NULL and adding nullable-migration churn just to surface a progress
 * spinner for a quarterly admin action is not worth it. The action awaits
 * the export and returns when done; the page lists prior datasets.
 *
 * The read-only portion (query → classList → split resolution) is factored
 * into collectExportCandidates so the export page can show a preview of
 * per-species-per-split counts before the admin commits to an export. The
 * preview NEVER persists split assignments — only exportTrainingDataset does.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import pLimit from "p-limit";
import { eq, and, inArray, gte, sql, isNotNull } from "drizzle-orm";

import { db } from "@/db";
import {
  detections,
  images,
  identifications,
  deployments,
  cameraTrapTrainingDatasets,
  processingJobs,
  type CameraTrapTrainingDataset,
  type ProcessingJob,
} from "@/db/schema";
import { requireAdmin, requirePermission } from "@/lib/auth";
import type { ActionResult } from "@/lib/types";
import {
  downloadFileToBuffer,
  uploadLocalFileToSharedDrive,
  deleteDriveFile,
} from "@/lib/drive-client";
import { ML_DEFAULTS } from "@/lib/ml-defaults";
import {
  recordEvent,
  buildJobStartEvent,
  buildJobCompletionEvent,
} from "@/lib/system-events";
import { JOB_TYPES } from "@/lib/job-types";
import { log } from "@/lib/log";
import {
  speciesFolderName,
  computeContentHash,
  buildCounts,
  buildManifest,
  buildCropsCsv,
  buildPreviewDeltas,
  stratifyDeploymentSplits,
  selectIncludedClasses,
  findUncoveredLabels,
  SPLIT_STRATEGY_VERSION,
  STRATIFY_MIN_DEPLOYMENTS,
  type HashRow,
  type CropCsvRow,
  type QualityParams,
  type Split,
  type ForcedReassignment,
  type ManifestCounts,
  type PreviewDeltaRow,
  type SplitTotals,
} from "@/lib/training-export-helpers";

const execFileAsync = promisify(execFile);

const EXPORT_ROOT = path.join(process.cwd(), "data", "training-exports");
const CROP_LONG_EDGE = 512;
const BBOX_PADDING = 0.05;
const JPEG_QUALITY = 90;
const DEFAULT_MIN_EXAMPLES = 50;
/** Floor for the detection-confidence knob. Detections below the 0.1
 * capture threshold are never stored (MegaDetector runs at 0.1), so an
 * export can only filter UP from here. */
const MIN_CONFIDENCE_FLOOR = ML_DEFAULTS.confidenceThreshold; // 0.1
/** Shared Drive folder that packaged export archives are uploaded to. */
const TRAINING_EXPORT_DRIVE_FOLDER_ID =
  process.env.TRAINING_EXPORT_DRIVE_FOLDER_ID ??
  "11T9kj0Vgf584sFh1s9TYE11iL-Uu659c";
/** How many source images to download from Drive in parallel during a crop
 * run. Nearly every image is Drive-only (chunked ML deletes the full-res
 * cache), so the crop loop is network-bound; a small pool turns ~1 crop/sec
 * into 10-30x that. Conservative default because an unrelated ML job may be
 * downloading at the same time. Env-tunable. */
const EXPORT_DOWNLOAD_CONCURRENCY = Math.max(
  1,
  Number(process.env.CT_TRAINING_EXPORT_CONCURRENCY) || 8,
);
/** How often the crop loop writes its progress counter to the job row. The
 * floating progress bar polls this; writing every crop would serialize against
 * the SSE reader under busy_timeout, so we batch. */
const PROGRESS_WRITE_EVERY = 50;

/**
 * On-disk folder name for an export: `<YYYY-MM-DD>-<version>` (e.g.
 * `2026-05-29-v4`) so it sorts chronologically and matches the Drive archive
 * name. Legacy exports created before this scheme keep their bare `vN` folder;
 * the upload path always derives the real folder from the stored `manifestPath`,
 * so both schemes archive correctly.
 */
function exportFolderName(version: string, createdAt: Date): string {
  return `${createdAt.toISOString().slice(0, 10)}-${version}`;
}

/** Crop-quality + confidence knobs for an export. */
type ExportQuality = QualityParams;

const DEFAULT_QUALITY: ExportQuality = {
  detectionConfidenceFloor: MIN_CONFIDENCE_FLOOR,
  cropPadding: BBOX_PADDING,
  cropLongEdge: CROP_LONG_EDGE,
  jpegQuality: JPEG_QUALITY,
};

/**
 * Result of dispatching an export. The crop generation now runs as a tracked
 * background job (`training_export`), so the action returns immediately:
 * - `unchanged` — an identical export already exists (content-hash match); no
 *   job was started.
 * - `started` — a new `training_export` job is running; track it in the
 *   floating progress bar via `jobId`.
 */
export type ExportDispatchResult =
  | { kind: "unchanged"; datasetId: number; version: string }
  | { kind: "started"; jobId: number; version: string };

export interface ExportPreviewSpeciesRow {
  label: string;
  /** The on-disk folder name for this class in the exported dataset.
   * As of 2026-05 this IS the canonical scientific name (with spaces and
   * diacritics preserved) so re-classified detections link back to the
   * biochoco_species table natively. */
  folderName: string;
  total: number;
  train: number;
  val: number;
  test: number;
  trainDeployments: number;
  valDeployments: number;
  testDeployments: number;
  trainDeploymentNames: string[];
  valDeploymentNames: string[];
  testDeploymentNames: string[];
}

export interface ForcedReassignmentRow {
  label: string;
  deploymentId: number;
  deploymentName: string;
  from: Split;
  to: Split;
}

/**
 * The most recent completed export, used as the comparison baseline for the
 * preview's per-class/per-split deltas. Sourced from that export's on-disk
 * `manifest.json` (the DB row does not store per-class counts). Null when no
 * prior export exists or its manifest could not be read.
 */
export interface ExportPreviewBaseline {
  version: string;
  /** ISO timestamp of the baseline export (for "vs. v7 · DD/MM/YYYY"). */
  createdAt: string;
  minExamplesThreshold: number;
}

export interface ExportPreview {
  minExamples: number;
  /** Mirrors STRATIFY_MIN_DEPLOYMENTS — surfaced for UI copy so the
   * threshold appears alongside `minExamples` in the dropped-list summary. */
  minDeployments: number;
  totalCandidates: number;
  classList: string[];
  droppedSpecies: Record<string, number>;
  /** Distinct deployment count for each dropped species. Lets the UI show
   * "X ejemplos en Y instalaciones" so the admin can see whether a class
   * was dropped for examples or for deployment coverage. */
  droppedDeployments: Record<string, number>;
  perSpecies: ExportPreviewSpeciesRow[];
  deploymentCount: number;
  /** How many deployments would have a new train/val/test split persisted
   * on the next export. Zero means splits are already locked in for every
   * deployment with verified data. */
  newDeploymentSplits: number;
  /** True when the next export will clear all persisted splits and
   * re-stratify under the current SPLIT_STRATEGY_VERSION. */
  migrationApplied: boolean;
  splitStrategyVersion: number;
  /** Moves performed by the stratifier to guarantee val+test coverage for
   * species with >= STRATIFY_MIN_DEPLOYMENTS. */
  forcedReassignments: ForcedReassignmentRow[];
  /** Metadata about the export the deltas compare against. Null when there is
   * none (first export, or unreadable manifest) — the UI then shows no deltas. */
  baseline: ExportPreviewBaseline | null;
  /** Per-species rows merged with the baseline (current rows + "removed" ghost
   * rows). When `baseline` is null these carry current counts with null deltas. */
  deltaRows: PreviewDeltaRow[];
  /** Footer totals delta (current − baseline). Null when `baseline` is null. */
  deltaFooter: SplitTotals | null;
}

interface CandidateRow {
  detectionId: number;
  imageId: number;
  deploymentId: number;
  deploymentName: string;
  imagePath: string | null;
  driveFileId: string | null;
  filename: string;
  bboxX: number;
  bboxY: number;
  bboxWidth: number;
  bboxHeight: number;
  finalLabel: string;
  // Per-crop provenance for crops.csv.
  mlSpecies: string | null;
  correctedSpecies: string | null;
  verificationStatus: string;
  detectionConfidence: number | null;
  classifierConfidence: number | null;
  detectionClass: number;
  detectorModelVersion: string | null;
}

interface CollectedCandidates {
  /** Filtered to only rows whose label is in the surviving classList
   * (after both pre-stratify inclusion and post-stratify coverage drops). */
  filtered: CandidateRow[];
  /** Surviving classes — passed all pre-filter checks AND have non-zero
   * coverage in train, val, and test after stratification. */
  classList: string[];
  /** Labels dropped for any reason (below minExamples, below
   * STRATIFY_MIN_DEPLOYMENTS, or post-stratify zero coverage). Value is
   * the total example count at the time of drop. */
  droppedSpecies: Record<string, number>;
  /** Distinct deployments per label (computed from candidates, before
   * the pre-filter dropped anything). Used by the UI to show deployment
   * counts alongside example counts for dropped species. */
  labelDeployments: Map<string, Set<number>>;
  splitByDeployment: Map<number, Split>;
  /** Deployments whose final assignment differs from the value currently
   * persisted in deployments.training_split. exportTrainingDataset writes
   * these back; getExportPreview ignores them. */
  newAssignments: Array<{ id: number; split: Split }>;
  totalCandidatesBeforeFilter: number;
  /** True when there's no prior v2 manifest, so the next export will clear
   * all persisted splits and re-stratify from scratch. */
  migrationApplied: boolean;
  forcedReassignments: ForcedReassignment[];
  deploymentNameById: Map<number, string>;
}

/**
 * Pure-read collection of export candidates. Shared by the preview and the
 * export server actions. Does NOT persist anything.
 */
async function collectExportCandidates(
  minExamples: number,
  detectionConfidenceFloor: number = MIN_CONFIDENCE_FLOOR,
): Promise<CollectedCandidates> {
  // 1. Pull every verified animal detection joined with its identification
  //    and the parent image+deployment. The confidence floor filters up from
  //    the 0.1 capture threshold — raising it yields higher-quality crops.
  const rawRows = await db
    .select({
      detectionId: detections.id,
      imageId: images.id,
      deploymentId: images.deploymentId,
      deploymentName: deployments.name,
      imagePath: images.path,
      driveFileId: images.driveFileId,
      filename: images.filename,
      bboxX: detections.bboxX,
      bboxY: detections.bboxY,
      bboxWidth: detections.bboxWidth,
      bboxHeight: detections.bboxHeight,
      species: identifications.species,
      correctedSpecies: identifications.correctedSpecies,
      verificationStatus: identifications.verificationStatus,
      detectionConfidence: detections.detectionConfidence,
      classifierConfidence: identifications.confidence,
      detectionClass: detections.detectionClass,
      detectorModelVersion: detections.modelVersion,
      excluded: deployments.excluded,
    })
    .from(detections)
    .innerJoin(images, eq(images.id, detections.imageId))
    .innerJoin(
      identifications,
      eq(identifications.detectionId, detections.id),
    )
    .innerJoin(deployments, eq(deployments.id, images.deploymentId))
    .where(
      and(
        inArray(identifications.verificationStatus, ["verified", "corrected"]),
        eq(detections.detectionClass, 0),
        eq(deployments.excluded, false),
        gte(detections.detectionConfidence, detectionConfidenceFloor),
        // Exclude detections whose source image can never be fetched. The crop
        // loop downloads via `loadImageBytes`, which tries the local cache path
        // first but REQUIRES a driveFileId as the durable fallback (the local
        // cache is routinely deleted by chunked ML). A row with no driveFileId
        // is unfetchable-by-construction: it would be counted in `filtered` yet
        // never written to disk, inflating manifest.counts above the on-disk
        // JPEG count (the v4 overshoot bug). Dropping it here keeps the preview,
        // content hash, coverage guard, and disk in agreement.
        //
        // Hash-basis change: this removes rows from the set fed to
        // computeContentHash, so every existing dataset's hash shifts once — the
        // next export re-creates the dataset under a new version even on an
        // unchanged corpus. Same one-time, harmless effect documented for the
        // `quality` block in training-export-helpers.ts:computeContentHash.
        isNotNull(images.driveFileId),
      ),
    );

  const candidates: CandidateRow[] = rawRows.map((r) => ({
    detectionId: r.detectionId,
    imageId: r.imageId,
    deploymentId: r.deploymentId,
    deploymentName: r.deploymentName,
    imagePath: r.imagePath,
    driveFileId: r.driveFileId,
    filename: r.filename,
    bboxX: r.bboxX,
    bboxY: r.bboxY,
    bboxWidth: r.bboxWidth,
    bboxHeight: r.bboxHeight,
    finalLabel: (r.correctedSpecies ?? r.species ?? "").trim(),
    mlSpecies: r.species ?? null,
    correctedSpecies: r.correctedSpecies ?? null,
    verificationStatus: r.verificationStatus,
    detectionConfidence: r.detectionConfidence ?? null,
    classifierConfidence: r.classifierConfidence ?? null,
    detectionClass: r.detectionClass,
    detectorModelVersion: r.detectorModelVersion ?? null,
  }));

  // 2. Group by label, drop labels that fail either pre-filter:
  //    - total examples below minExamples → not enough signal
  //    - distinct deployments below STRATIFY_MIN_DEPLOYMENTS → cannot be
  //      balanced into train+val+test even after stratification
  const labelCounts = new Map<string, number>();
  const labelDeployments = new Map<string, Set<number>>();
  for (const c of candidates) {
    if (!c.finalLabel) continue;
    labelCounts.set(c.finalLabel, (labelCounts.get(c.finalLabel) ?? 0) + 1);
    if (!labelDeployments.has(c.finalLabel)) {
      labelDeployments.set(c.finalLabel, new Set<number>());
    }
    labelDeployments.get(c.finalLabel)!.add(c.deploymentId);
  }

  const { classList, droppedSpecies } = selectIncludedClasses({
    labelCounts,
    labelDeployments,
    minExamples,
    minDeployments: STRATIFY_MIN_DEPLOYMENTS,
  });

  const classListSet = new Set(classList);
  const filtered = candidates.filter(
    (c) => c.finalLabel && classListSet.has(c.finalLabel),
  );

  // 3. Resolve training_split per deployment via the stratifier.
  //    - migrationApplied=true means there's no prior dataset under the
  //      current SPLIT_STRATEGY_VERSION; the next export will clear every
  //      deployment's persisted split and start over (anchored = {}).
  //    - Otherwise we treat persisted splits as anchors and only stratify
  //      newly-verified deployments around them.
  const migrationApplied = await needsSplitStrategyMigration();

  const deploymentIds = Array.from(
    new Set(filtered.map((c) => c.deploymentId)),
  );

  // speciesByDeployment uses finalLabel from the filtered candidates so
  // dropped species don't influence stratification.
  const speciesByDeployment = new Map<number, Set<string>>();
  for (const c of filtered) {
    if (!speciesByDeployment.has(c.deploymentId)) {
      speciesByDeployment.set(c.deploymentId, new Set());
    }
    speciesByDeployment.get(c.deploymentId)!.add(c.finalLabel);
  }

  // Map deploymentId -> name for surfacing in UI / warnings.
  const deploymentNameById = new Map<number, string>();
  for (const c of filtered) {
    if (!deploymentNameById.has(c.deploymentId)) {
      deploymentNameById.set(c.deploymentId, c.deploymentName);
    }
  }

  const anchored = new Map<number, Split>();
  const persistedByDeployment = new Map<number, Split | null>();

  if (deploymentIds.length > 0) {
    const existingSplits = await db
      .select({ id: deployments.id, trainingSplit: deployments.trainingSplit })
      .from(deployments)
      .where(inArray(deployments.id, deploymentIds));

    for (const dep of existingSplits) {
      const value =
        dep.trainingSplit === "train" ||
        dep.trainingSplit === "val" ||
        dep.trainingSplit === "test"
          ? dep.trainingSplit
          : null;
      persistedByDeployment.set(dep.id, value);
      // During a migration, no deployment is anchored — the export will
      // clear all persisted splits before writing the new assignments.
      if (!migrationApplied && value !== null) {
        anchored.set(dep.id, value);
      }
    }
  }

  const stratified = stratifyDeploymentSplits({
    deploymentIds,
    speciesByDeployment,
    anchored,
  });

  const splitByDeployment = stratified.splitByDeployment;
  const newAssignments: Array<{ id: number; split: Split }> = [];
  for (const id of deploymentIds) {
    const finalSplit = splitByDeployment.get(id);
    if (!finalSplit) continue;
    const persisted = persistedByDeployment.get(id) ?? null;
    if (persisted !== finalSplit) {
      newAssignments.push({ id, split: finalSplit });
    }
  }

  // 4. Defensive post-stratify drop. The deployment-count pre-filter should
  //    already guarantee every surviving class has ≥3 deployments and the
  //    stratifier should give 1/1/1 coverage. The one residual failure mode
  //    is anchored deployments: if 3+ deployments for a class are all
  //    anchored to the same split (from a prior export when the species had
  //    fewer cameras), the stratifier emits a warning but can't move them.
  //    Drop those classes here rather than ship a manifest the classifier
  //    will reject.
  const perLabelSplitCounts = new Map<
    string,
    { train: number; val: number; test: number }
  >();
  for (const c of filtered) {
    const split = splitByDeployment.get(c.deploymentId);
    if (!split) continue;
    const counts = perLabelSplitCounts.get(c.finalLabel) ?? {
      train: 0,
      val: 0,
      test: 0,
    };
    counts[split] += 1;
    perLabelSplitCounts.set(c.finalLabel, counts);
  }

  const uncovered = findUncoveredLabels(perLabelSplitCounts);
  let survivingClassList = classList;
  let survivingFiltered = filtered;
  let survivingForcedReassignments = stratified.forcedReassignments;

  if (uncovered.length > 0) {
    const uncoveredSet = new Set(uncovered);
    for (const label of uncovered) {
      const counts = perLabelSplitCounts.get(label)!;
      droppedSpecies[label] = counts.train + counts.val + counts.test;
      log.warn(
        { label, counts },
        "[training-export] post-stratify drop: class survived inclusion but " +
          "stratifier could not give it val+test coverage (likely anchored " +
          "deployments). Dropping from classList.",
      );
    }
    survivingClassList = classList.filter((l) => !uncoveredSet.has(l));
    survivingFiltered = filtered.filter(
      (r) => !uncoveredSet.has(r.finalLabel),
    );
    survivingForcedReassignments = stratified.forcedReassignments.filter(
      (r) => !uncoveredSet.has(r.label),
    );
  }

  return {
    filtered: survivingFiltered,
    classList: survivingClassList,
    droppedSpecies,
    labelDeployments,
    splitByDeployment,
    newAssignments,
    totalCandidatesBeforeFilter: candidates.length,
    migrationApplied,
    forcedReassignments: survivingForcedReassignments,
    deploymentNameById,
  };
}

/**
 * Detect whether the next export should run the one-time v2 migration:
 * clear every persisted deployments.training_split and re-stratify from
 * scratch. Returns true iff the most recent training dataset (if any) was
 * built under a SPLIT_STRATEGY_VERSION less than the current one.
 *
 * When no dataset exists yet, the column is either empty (no migration
 * needed — first export ever) or already populated by an older code path.
 * We treat the latter as needing migration so v2 takes effect on first use.
 */
async function needsSplitStrategyMigration(): Promise<boolean> {
  const latest = await db
    .select({ manifestPath: cameraTrapTrainingDatasets.manifestPath })
    .from(cameraTrapTrainingDatasets)
    .orderBy(sql`${cameraTrapTrainingDatasets.id} desc`)
    .limit(1);

  if (latest.length === 0) {
    // No prior dataset. If any deployment already has a persisted split, it
    // was assigned by older code — trigger migration. Otherwise no-op.
    const anyPersisted = await db
      .select({ id: deployments.id })
      .from(deployments)
      .where(sql`${deployments.trainingSplit} is not null`)
      .limit(1);
    return anyPersisted.length > 0;
  }

  try {
    const manifestRaw = await fs.readFile(latest[0].manifestPath, "utf8");
    const manifest = JSON.parse(manifestRaw) as {
      splitStrategyVersion?: number;
    };
    const ver = manifest.splitStrategyVersion ?? 0;
    return ver < SPLIT_STRATEGY_VERSION;
  } catch (err) {
    // Manifest unreadable — assume migration is needed so we don't compound
    // a bad state.
    log.warn(
      { err, path: latest[0].manifestPath },
      "[training-export] could not read latest manifest; assuming migration needed",
    );
    return true;
  }
}

/**
 * Load the most recent completed export as a comparison baseline for the
 * preview deltas. Dataset rows are inserted only on successful finalize, so the
 * highest `id` is the latest completed export. Per-class/per-split counts are
 * NOT stored in the DB — they live only in the export's on-disk `manifest.json`
 * — so read and parse it (same pattern as `needsSplitStrategyMigration`).
 *
 * Returns null and never throws when there is no prior export, the
 * `manifestPath` is missing, the file is unreadable, or the manifest lacks
 * `counts.perClass` (legacy/partial). The caller then shows no deltas.
 */
async function loadBaselineExport(): Promise<{
  meta: ExportPreviewBaseline;
  counts: ManifestCounts;
} | null> {
  const latest = await db
    .select({
      version: cameraTrapTrainingDatasets.version,
      createdAt: cameraTrapTrainingDatasets.createdAt,
      minExamplesThreshold: cameraTrapTrainingDatasets.minExamplesThreshold,
      manifestPath: cameraTrapTrainingDatasets.manifestPath,
    })
    .from(cameraTrapTrainingDatasets)
    .orderBy(sql`${cameraTrapTrainingDatasets.id} desc`)
    .limit(1);

  if (latest.length === 0 || !latest[0].manifestPath) return null;

  try {
    const raw = await fs.readFile(latest[0].manifestPath, "utf8");
    const manifest = JSON.parse(raw) as { counts?: Partial<ManifestCounts> };
    const counts = manifest.counts;
    // Shape guard: legacy/partial manifests without per-class counts degrade
    // to "no baseline" rather than crashing the preview.
    if (
      !counts ||
      typeof counts.perClass !== "object" ||
      counts.perClass === null
    ) {
      return null;
    }
    return {
      meta: {
        version: latest[0].version,
        createdAt: latest[0].createdAt.toISOString(),
        minExamplesThreshold: latest[0].minExamplesThreshold,
      },
      counts: {
        total: counts.total ?? 0,
        train: counts.train ?? 0,
        val: counts.val ?? 0,
        test: counts.test ?? 0,
        perClass: counts.perClass,
      },
    };
  } catch (err) {
    log.warn(
      { err, path: latest[0].manifestPath },
      "[training-export] baseline manifest unreadable; preview deltas suppressed",
    );
    return null;
  }
}

/**
 * Read-only preview of what the next export would contain, given a
 * `minExamples` threshold. Used by the training-exports page to show a
 * per-species-per-split sample table before the admin commits.
 *
 * Does NOT persist anything. In particular, deployments that would get a
 * fresh split on export still show `trainingSplit = null` in the DB after
 * this action returns. They're reported via `newDeploymentSplits`.
 */
export async function getExportPreview(
  minExamples: number,
  detectionConfidenceFloor: number = MIN_CONFIDENCE_FLOOR,
): Promise<ActionResult<ExportPreview>> {
  await requireAdmin();

  if (!Number.isFinite(minExamples) || minExamples < 1) {
    return { success: false, error: "minExamples must be a positive integer" };
  }
  if (
    !Number.isFinite(detectionConfidenceFloor) ||
    detectionConfidenceFloor < MIN_CONFIDENCE_FLOOR ||
    detectionConfidenceFloor > 1
  ) {
    return {
      success: false,
      error: `El umbral de confianza debe estar entre ${MIN_CONFIDENCE_FLOOR} y 1.`,
    };
  }

  try {
    const collected = await collectExportCandidates(
      minExamples,
      detectionConfidenceFloor,
    );

    // Aggregate per-label-per-split counts AND per-label-per-split distinct
    // deployments in a single pass. The deployment sets let the UI show whether
    // a skewed split is class-imbalanced or deployment-imbalanced.
    const perLabelCounts = new Map<
      string,
      { train: number; val: number; test: number }
    >();
    const perLabelDeployments = new Map<
      string,
      { train: Set<string>; val: Set<string>; test: Set<string> }
    >();
    for (const row of collected.filtered) {
      const split = collected.splitByDeployment.get(row.deploymentId);
      if (!split) continue;
      const existingCounts = perLabelCounts.get(row.finalLabel) ?? {
        train: 0,
        val: 0,
        test: 0,
      };
      existingCounts[split] += 1;
      perLabelCounts.set(row.finalLabel, existingCounts);

      const existingDeps = perLabelDeployments.get(row.finalLabel) ?? {
        train: new Set<string>(),
        val: new Set<string>(),
        test: new Set<string>(),
      };
      existingDeps[split].add(row.deploymentName);
      perLabelDeployments.set(row.finalLabel, existingDeps);
    }

    const sortNames = (s: Set<string>) =>
      Array.from(s).sort((a, b) => a.localeCompare(b, "es"));

    const perSpecies: ExportPreviewSpeciesRow[] = Array.from(
      perLabelCounts.entries(),
    )
      .map(([label, splitCounts]) => {
        const depSets = perLabelDeployments.get(label) ?? {
          train: new Set<string>(),
          val: new Set<string>(),
          test: new Set<string>(),
        };
        return {
          label,
          folderName: speciesFolderName(label),
          total: splitCounts.train + splitCounts.val + splitCounts.test,
          train: splitCounts.train,
          val: splitCounts.val,
          test: splitCounts.test,
          trainDeployments: depSets.train.size,
          valDeployments: depSets.val.size,
          testDeployments: depSets.test.size,
          trainDeploymentNames: sortNames(depSets.train),
          valDeploymentNames: sortNames(depSets.val),
          testDeploymentNames: sortNames(depSets.test),
        };
      })
      .sort((a, b) => b.total - a.total);

    const deploymentCount = collected.splitByDeployment.size;

    const forcedReassignments: ForcedReassignmentRow[] =
      collected.forcedReassignments.map((r) => ({
        label: r.label,
        deploymentId: r.deploymentId,
        deploymentName:
          collected.deploymentNameById.get(r.deploymentId) ??
          `#${r.deploymentId}`,
        from: r.from,
        to: r.to,
      }));

    // Distinct-deployment count for every dropped species, so the UI can
    // show "X ejemplos en Y instalaciones" and the admin immediately sees
    // whether the threshold knob to tune is examples or cameras.
    const droppedDeployments: Record<string, number> = {};
    for (const label of Object.keys(collected.droppedSpecies)) {
      droppedDeployments[label] =
        collected.labelDeployments.get(label)?.size ?? 0;
    }

    // Compare against the most recent completed export so the preview can show
    // per-class/per-split deltas (+N/−N) inline.
    const baseline = await loadBaselineExport();
    const { rows: deltaRows, footer: deltaFooter } = buildPreviewDeltas(
      perSpecies,
      baseline?.counts ?? null,
    );

    return {
      success: true,
      data: {
        minExamples,
        minDeployments: STRATIFY_MIN_DEPLOYMENTS,
        totalCandidates: collected.totalCandidatesBeforeFilter,
        classList: collected.classList,
        droppedSpecies: collected.droppedSpecies,
        droppedDeployments,
        perSpecies,
        deploymentCount,
        newDeploymentSplits: collected.newAssignments.length,
        migrationApplied: collected.migrationApplied,
        splitStrategyVersion: SPLIT_STRATEGY_VERSION,
        forcedReassignments,
        baseline: baseline?.meta ?? null,
        deltaRows,
        deltaFooter,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, "[training-export] preview failed");
    return { success: false, error: msg };
  }
}

/** Parse an optional numeric FormData field, falling back to a default. */
function parseNumberField(
  formData: FormData,
  name: string,
  fallback: number,
  parseFn: (s: string) => number = Number.parseFloat,
): number {
  const raw = formData.get(name);
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  const n = parseFn(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Server action — export a versioned training dataset.
 *
 * Form fields (all optional, sensible defaults):
 *   - `minExamples` (integer, default 50)
 *   - `detectionConfidenceFloor` (float ≥ 0.1, default 0.1)
 *   - `cropPadding` (float ≥ 0, default 0.05)
 *   - `cropLongEdge` (integer ≥ 32, default 512)
 *   - `jpegQuality` (integer 1–100, default 90)
 */
export async function exportTrainingDataset(
  formData: FormData,
): Promise<ActionResult<ExportDispatchResult>> {
  const user = await requireAdmin();

  const minExamplesRaw = formData.get("minExamples");
  const parsed =
    typeof minExamplesRaw === "string" && minExamplesRaw.trim().length > 0
      ? Number.parseInt(minExamplesRaw, 10)
      : DEFAULT_MIN_EXAMPLES;
  if (!Number.isFinite(parsed) || parsed < 1) {
    return { success: false, error: "minExamples must be a positive integer" };
  }
  const minExamples = parsed;

  // Crop-quality knobs (Phase 2). Validate ranges; confidence floor cannot go
  // below the 0.1 capture threshold because lower detections were never stored.
  const quality: ExportQuality = {
    detectionConfidenceFloor: parseNumberField(
      formData,
      "detectionConfidenceFloor",
      DEFAULT_QUALITY.detectionConfidenceFloor,
    ),
    cropPadding: parseNumberField(
      formData,
      "cropPadding",
      DEFAULT_QUALITY.cropPadding,
    ),
    cropLongEdge: parseNumberField(
      formData,
      "cropLongEdge",
      DEFAULT_QUALITY.cropLongEdge,
      (s) => Number.parseInt(s, 10),
    ),
    jpegQuality: parseNumberField(
      formData,
      "jpegQuality",
      DEFAULT_QUALITY.jpegQuality,
      (s) => Number.parseInt(s, 10),
    ),
  };
  if (
    quality.detectionConfidenceFloor < MIN_CONFIDENCE_FLOOR ||
    quality.detectionConfidenceFloor > 1
  ) {
    return {
      success: false,
      error: `El umbral de confianza debe estar entre ${MIN_CONFIDENCE_FLOOR} y 1. Las detecciones por debajo de ${MIN_CONFIDENCE_FLOOR} no se almacenan y requerirían reprocesar las imágenes.`,
    };
  }
  if (quality.cropPadding < 0 || quality.cropPadding > 1) {
    return {
      success: false,
      error: "El padding de recorte debe estar entre 0 y 1.",
    };
  }
  if (quality.cropLongEdge < 32 || quality.cropLongEdge > 4096) {
    return {
      success: false,
      error: "El lado largo del recorte debe estar entre 32 y 4096 px.",
    };
  }
  if (quality.jpegQuality < 1 || quality.jpegQuality > 100) {
    return {
      success: false,
      error: "La calidad JPEG debe estar entre 1 y 100.",
    };
  }

  try {
    const collected = await collectExportCandidates(
      minExamples,
      quality.detectionConfidenceFloor,
    );

    if (collected.totalCandidatesBeforeFilter === 0) {
      return {
        success: false,
        error:
          "No hay detecciones verificadas (verified/corrected) para exportar.",
      };
    }

    if (collected.classList.length === 0) {
      return {
        success: false,
        error: `Ninguna especie alcanza el umbral de ${minExamples} ejemplos verificados.`,
      };
    }

    const {
      filtered,
      classList,
      droppedSpecies,
      splitByDeployment,
      newAssignments,
      migrationApplied,
    } = collected;

    // Persist the split assignments BEFORE computing the hash, so a re-run
    // over the same corpus produces the same hash. On the one-time v2
    // migration, clear EVERY persisted training_split first — the stratifier
    // ran with anchored={} so the writeback below restores them with the
    // newly-balanced values.
    if (migrationApplied || newAssignments.length > 0) {
      db.transaction((tx) => {
        if (migrationApplied) {
          tx.update(deployments)
            .set({ trainingSplit: null })
            .where(sql`${deployments.trainingSplit} is not null`)
            .run();
          log.info(
            { splitStrategyVersion: SPLIT_STRATEGY_VERSION },
            "[training-export] cleared all training_split values for migration",
          );
        }
        for (const a of newAssignments) {
          tx.update(deployments)
            .set({ trainingSplit: a.split })
            .where(eq(deployments.id, a.id))
            .run();
        }
      });
    }

    // Build hash rows + content hash.
    const hashRows: HashRow[] = filtered.map((c) => ({
      imageId: c.imageId,
      finalLabel: c.finalLabel,
      deploymentId: c.deploymentId,
      split: splitByDeployment.get(c.deploymentId)!,
    }));

    const contentHash = computeContentHash({
      rows: hashRows,
      minExamples,
      classList,
      quality,
    });

    // Short-circuit if an identical export already exists.
    const existing = await db
      .select()
      .from(cameraTrapTrainingDatasets)
      .where(eq(cameraTrapTrainingDatasets.contentHash, contentHash))
      .limit(1);

    if (existing.length > 0) {
      const row = existing[0];
      return {
        success: true,
        data: { kind: "unchanged", datasetId: row.id, version: row.version },
      };
    }

    // Won the content-hash check. Claim the single-flight slot ATOMICALLY:
    // better-sqlite3 transactions run synchronously on one connection, so this
    // check-then-insert cannot interleave with another export's claim. Only the
    // winner gets a job row; a concurrent caller gets `null` and bails.
    const jobRow = db.transaction((tx) => {
      const active = tx
        .select({ id: processingJobs.id })
        .from(processingJobs)
        .where(
          and(
            eq(processingJobs.jobType, JOB_TYPES.TRAINING_EXPORT),
            inArray(processingJobs.status, ["pending", "processing"]),
          ),
        )
        .limit(1)
        .all();
      if (active.length > 0) return null;
      return tx
        .insert(processingJobs)
        .values({
          jobType: JOB_TYPES.TRAINING_EXPORT,
          status: "processing",
          totalImages: filtered.length,
          processedImages: 0,
          createdBy: user.email,
          startedAt: new Date(),
          statusMessage: "Preparando exporte…",
        })
        .returning()
        .get() as ProcessingJob;
    });

    if (!jobRow) {
      return {
        success: false,
        error:
          "Ya hay un exporte de entrenamiento en curso. Espera a que termine.",
      };
    }

    await recordEvent(buildJobStartEvent(jobRow));

    // Allocate version + on-disk folder AFTER winning the claim, so two racing
    // exports can never grab the same vN or write into the same folder. The
    // folder is date-prefixed (`<YYYY-MM-DD>-vN`) to match the Drive archive
    // name and sort chronologically.
    const createdAt = new Date();
    const maxIdRow = await db
      .select({ maxId: sql<number | null>`max(id)` })
      .from(cameraTrapTrainingDatasets);
    const version = `v${(maxIdRow[0]?.maxId ?? 0) + 1}`;
    const versionDir = path.join(
      EXPORT_ROOT,
      exportFolderName(version, createdAt),
    );
    await fs.mkdir(versionDir, { recursive: true });

    // Heavy work (download → crop → manifest → dataset insert) runs detached so
    // the request returns immediately; progress + cancellation live on the job
    // row and surface in the floating progress bar.
    void processTrainingExportJobInternal({
      jobId: jobRow.id,
      filtered,
      classList,
      droppedSpecies,
      splitByDeployment,
      quality,
      minExamples,
      contentHash,
      version,
      versionDir,
      createdAt,
      createdBy: user.email,
    }).catch((err) => {
      // Last-resort net: the processor writes its own terminal row, so this
      // only fires if that itself threw. Mark failed + emit, best-effort.
      void markExportJobFailed(jobRow.id, err);
    });

    return {
      success: true,
      data: { kind: "started", jobId: jobRow.id, version },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, "[training-export] dispatch failed");
    return { success: false, error: msg };
  }
}

interface ProcessExportArgs {
  jobId: number;
  filtered: CandidateRow[];
  classList: string[];
  droppedSpecies: Record<string, number>;
  splitByDeployment: Map<number, Split>;
  quality: ExportQuality;
  minExamples: number;
  contentHash: string;
  version: string;
  versionDir: string;
  createdAt: Date;
  createdBy: string;
}

/**
 * Background crop generation for a `training_export` job. Downloads each source
 * image ONCE (grouped by imageId) with bounded concurrency, crops every
 * detection from it in-memory, and writes determinate progress to the job row.
 * Cooperative cancellation: the loop polls the job status between images; the
 * cancel action flips it to `cancelled` and owns the terminal event, so this
 * function just stops and leaves the partial folder for a fast retry.
 */
async function processTrainingExportJobInternal(
  args: ProcessExportArgs,
): Promise<void> {
  const {
    jobId,
    filtered,
    classList,
    droppedSpecies,
    splitByDeployment,
    quality,
    minExamples,
    contentHash,
    version,
    versionDir,
    createdAt,
    createdBy,
  } = args;

  const startedAt = Date.now();
  let eventEmitted = false;
  const emitTerminal = async (extras?: Record<string, unknown>) => {
    if (eventEmitted) return;
    eventEmitted = true;
    const [latest] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId))
      .limit(1);
    if (latest) await recordEvent(buildJobCompletionEvent(latest, extras));
  };
  const isCancelled = async (): Promise<boolean> => {
    const [j] = await db
      .select({ status: processingJobs.status })
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId))
      .limit(1);
    return !j || j.status !== "processing";
  };

  try {
    log.info(
      {
        jobId,
        version,
        crops: filtered.length,
        classes: classList.length,
        concurrency: EXPORT_DOWNLOAD_CONCURRENCY,
      },
      "[training-export] starting export",
    );

    // Group candidates by source image so each Drive object downloads once.
    // Keep each row's index in `filtered` so crops.csv stays deterministic
    // regardless of download-completion order.
    const byImage = new Map<number, { row: CandidateRow; idx: number }[]>();
    filtered.forEach((row, idx) => {
      const g = byImage.get(row.imageId);
      if (g) g.push({ row, idx });
      else byImage.set(row.imageId, [{ row, idx }]);
    });

    const csvSlots: (CropCsvRow | null)[] = new Array(filtered.length).fill(
      null,
    );
    const warnings: string[] = [];
    let written = 0;
    let failedCrops = 0;
    let processed = 0; // attempted (written + skipped + failed) — reaches total
    let lastWriteAt = 0;

    const tick = async (force = false): Promise<void> => {
      if (!force && processed - lastWriteAt < PROGRESS_WRITE_EVERY) return;
      lastWriteAt = processed;
      // Write the ABSOLUTE counter (never processedImages + 1) so overlapping
      // throttled writes from the pool are last-writer-wins-safe.
      await db
        .update(processingJobs)
        .set({
          processedImages: processed,
          failedImages: failedCrops,
          statusMessage: `Generando recortes... (${processed} de ${filtered.length})`,
        })
        .where(eq(processingJobs.id, jobId));
      const elapsed = (Date.now() - startedAt) / 1000;
      const rate = processed / Math.max(elapsed, 0.001);
      log.info(
        {
          jobId,
          processed,
          total: filtered.length,
          written,
          failed: failedCrops,
          ratePerSec: +rate.toFixed(1),
          etaSec: Math.round((filtered.length - processed) / Math.max(rate, 0.001)),
          rssMb: Math.round(process.memoryUsage().rss / 1048576),
        },
        "[training-export] progress",
      );
    };

    const addWarning = (detectionId: number, msg: string) => {
      warnings.push(`detection ${detectionId}: ${msg}`);
      if (warnings.length <= 5) {
        log.warn(
          { jobId, detectionId, err: msg },
          "[training-export] crop failed for detection",
        );
      }
    };

    const limit = pLimit(EXPORT_DOWNLOAD_CONCURRENCY);
    let cancelled = false;

    await Promise.all(
      [...byImage.values()].map((group) =>
        limit(async () => {
          if (cancelled) return;
          if (await isCancelled()) {
            cancelled = true;
            return;
          }

          let buffer: Buffer;
          try {
            buffer = await loadImageBytes(group[0].row);
          } catch (err) {
            // Download exhausted retries (404 / permanent) — withRetry already
            // absorbed transient 429/5xx, so skip this image's whole group.
            const msg = err instanceof Error ? err.message : String(err);
            for (const { row } of group) {
              addWarning(row.detectionId, msg);
              failedCrops += 1;
            }
            processed += group.length;
            await tick();
            return;
          }

          for (const { row, idx } of group) {
            const split = splitByDeployment.get(row.deploymentId)!;
            const folderName = speciesFolderName(row.finalLabel);
            const outDir = path.join(versionDir, split, folderName);
            const outPath = path.join(outDir, `${row.detectionId}.jpg`);
            try {
              await fs.mkdir(outDir, { recursive: true });
              await cropAndWriteAtomic(buffer, row, outPath, quality);
              written += 1;
              csvSlots[idx] = {
                // POSIX-style relative path regardless of OS.
                cropPath: [split, folderName, `${row.detectionId}.jpg`].join("/"),
                detectionId: row.detectionId,
                imageId: row.imageId,
                deploymentId: row.deploymentId,
                deploymentName: row.deploymentName,
                split,
                label: row.finalLabel,
                mlSpecies: row.mlSpecies,
                correctedSpecies: row.correctedSpecies,
                verificationStatus: row.verificationStatus,
                mdConfidence: row.detectionConfidence,
                classifierConfidence: row.classifierConfidence,
                bboxX: row.bboxX,
                bboxY: row.bboxY,
                bboxWidth: row.bboxWidth,
                bboxHeight: row.bboxHeight,
                detectionClass: row.detectionClass,
                detectorModelVersion: row.detectorModelVersion,
              };
            } catch (err) {
              // Disk-full is fatal for the whole job; anything else is a per-crop
              // warning (skip + continue).
              if (
                err instanceof Error &&
                (err as NodeJS.ErrnoException).code === "ENOSPC"
              ) {
                throw new Error("Sin espacio en disco al generar recortes.");
              }
              addWarning(
                row.detectionId,
                err instanceof Error ? err.message : String(err),
              );
              failedCrops += 1;
            }
            processed += 1;
            await tick();
          }
        }),
      ),
    );

    // Cancelled mid-run: the cancel action set status='cancelled' and emitted
    // the terminal event. Leave the partial folder on disk for a fast retry.
    if (cancelled || (await isCancelled())) {
      log.info({ jobId, version, written }, "[training-export] cancelled");
      return;
    }

    await tick(true);

    // Counts, manifest, and per-deployment summaries derive from the crops
    // ACTUALLY written to disk (csvSlots non-null) — never the pre-fetch
    // candidate set. A detection whose source image was unreachable at fetch
    // time was skipped (see addWarning) and must not inflate counts above the
    // on-disk JPEG count (the v4 overshoot bug). crops.csv already uses this set.
    let writtenRows = csvSlots.filter((r): r is CropCsvRow => r !== null);

    // Defensive coverage re-check over the WRITTEN set. The collection-time
    // driveFileId pre-filter + the pre-fetch findUncoveredLabels guard already
    // guarantee every surviving class has val+test coverage in `filtered`. The
    // one residual failure mode is a TRANSIENT fetch failure (driveFileId
    // present but Drive 404'd at fetch) that zeroes a class's only val/test
    // crop. Shipping that re-trips the classifier's load_manifest assertion, so
    // instead drop the class: remove it from classList + counts, prune its
    // already-written crops, and record it under droppedSpecies. With the
    // collection pre-filter in place this should essentially never fire.
    const writtenPerLabelSplit = new Map<
      string,
      { train: number; val: number; test: number }
    >();
    for (const r of writtenRows) {
      const c = writtenPerLabelSplit.get(r.label) ?? {
        train: 0,
        val: 0,
        test: 0,
      };
      c[r.split] += 1;
      writtenPerLabelSplit.set(r.label, c);
    }
    let finalClassList = classList;
    const uncoveredAfterWrite = findUncoveredLabels(writtenPerLabelSplit).filter(
      (label) => classList.includes(label),
    );
    if (uncoveredAfterWrite.length > 0) {
      const dropSet = new Set(uncoveredAfterWrite);
      for (const label of uncoveredAfterWrite) {
        const c = writtenPerLabelSplit.get(label) ?? {
          train: 0,
          val: 0,
          test: 0,
        };
        droppedSpecies[label] = c.train + c.val + c.test;
        log.warn(
          { jobId, version, label, counts: c },
          "[training-export] post-write drop: surviving class lost val/test " +
            "coverage to fetch failures. Dropping from classList, pruning crops.",
        );
        // Prune already-written crops for this class across all three splits.
        const folderName = speciesFolderName(label);
        await Promise.all(
          (["train", "val", "test"] as const).map((split) =>
            fs.rm(path.join(versionDir, split, folderName), {
              recursive: true,
              force: true,
            }),
          ),
        );
      }
      finalClassList = classList.filter((l) => !dropSet.has(l));
      writtenRows = writtenRows.filter((r) => !dropSet.has(r.label));
    }

    const writtenCount = writtenRows.length;

    // Manifest + per-deployment counts (over the written set only). A
    // deployment whose every crop failed contributes nothing here and is
    // omitted from the summary.
    const counts = buildCounts(
      writtenRows.map((r) => ({ finalLabel: r.label, split: r.split })),
    );
    const perDeploymentCounts = new Map<number, number>();
    for (const r of writtenRows) {
      perDeploymentCounts.set(
        r.deploymentId,
        (perDeploymentCounts.get(r.deploymentId) ?? 0) + 1,
      );
    }
    const deploymentSummaries = Array.from(perDeploymentCounts.entries())
      .map(([id, imageCount]) => ({
        id,
        split: splitByDeployment.get(id)!,
        imageCount,
      }))
      .sort((a, b) => a.id - b.id);

    const manifest = buildManifest({
      version,
      contentHash,
      createdAt,
      createdBy,
      minExamplesThreshold: minExamples,
      classList: finalClassList.map((label) => speciesFolderName(label)),
      droppedSpecies,
      counts,
      deployments: deploymentSummaries,
      warnings,
      pipeline: {
        detectorModel: ML_DEFAULTS.detectorModel,
        detectionConfidenceFloor: quality.detectionConfidenceFloor,
        detectionThresholdAtCapture: MIN_CONFIDENCE_FLOOR,
        cropPadding: quality.cropPadding,
        cropLongEdge: quality.cropLongEdge,
        jpegQuality: quality.jpegQuality,
      },
    });
    const manifestPath = path.join(versionDir, "manifest.json");
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    // Per-crop provenance CSV, in deterministic order (written set).
    const csvRows = writtenRows;
    await fs.writeFile(
      path.join(versionDir, "crops.csv"),
      buildCropsCsv(csvRows, {
        cropPadding: quality.cropPadding,
        cropLongEdge: quality.cropLongEdge,
        jpegQuality: quality.jpegQuality,
      }),
    );

    // Insert the dataset row AND flip the job to completed atomically, guarded
    // by status='processing' so a last-instant cancel can't leave a completed
    // dataset attached to a cancelled job.
    const committed = db.transaction((tx) => {
      const [j] = tx
        .select({ status: processingJobs.status })
        .from(processingJobs)
        .where(eq(processingJobs.id, jobId))
        .limit(1)
        .all();
      if (!j || j.status !== "processing") return null;
      const ds = tx
        .insert(cameraTrapTrainingDatasets)
        .values({
          version,
          contentHash,
          createdBy,
          createdAt,
          imageCount: writtenCount,
          classCount: finalClassList.length,
          minExamplesThreshold: minExamples,
          classListJson: JSON.stringify(
            finalClassList.map((label) => speciesFolderName(label)),
          ),
          droppedSpeciesJson: JSON.stringify(droppedSpecies),
          deploymentsJson: JSON.stringify(deploymentSummaries),
          manifestPath,
          detectionConfidenceFloor: quality.detectionConfidenceFloor,
          cropPadding: quality.cropPadding,
          cropLongEdge: quality.cropLongEdge,
          jpegQuality: quality.jpegQuality,
        })
        .returning()
        .get() as CameraTrapTrainingDataset;
      tx.update(processingJobs)
        .set({
          status: "completed",
          completedAt: new Date(),
          statusMessage: null,
          processedImages: filtered.length,
        })
        .where(eq(processingJobs.id, jobId))
        .run();
      return ds;
    });

    if (!committed) {
      log.info({ jobId, version }, "[training-export] cancelled at finalize");
      return;
    }

    log.info(
      {
        jobId,
        version,
        elapsedSec: ((Date.now() - startedAt) / 1000).toFixed(1),
        written: writtenCount,
        total: filtered.length,
        classes: finalClassList.length,
        warnings: warnings.length,
      },
      "[training-export] done",
    );

    await emitTerminal({
      version,
      imageCount: writtenCount,
      classCount: finalClassList.length,
      minExamples,
      warnings: warnings.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, jobId, version }, "[training-export] job failed");
    await db
      .update(processingJobs)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorMessage: msg,
        statusMessage: null,
      })
      .where(eq(processingJobs.id, jobId));
    await emitTerminal();
  }
}

/**
 * Last-resort terminal write for a fire-and-forget export/upload job whose
 * processor threw before writing its own terminal row. Guarded so it never
 * clobbers an already-terminal row, and emits the completion event once.
 */
async function markExportJobFailed(jobId: number, err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  log.error({ err, jobId }, "[training-export] dispatch-level failure");
  try {
    await db
      .update(processingJobs)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorMessage: msg,
        statusMessage: null,
      })
      .where(
        and(
          eq(processingJobs.id, jobId),
          inArray(processingJobs.status, ["pending", "processing"]),
        ),
      );
    const [latest] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId))
      .limit(1);
    if (latest && latest.status === "failed") {
      await recordEvent(buildJobCompletionEvent(latest));
    }
  } catch (e) {
    log.error({ err: e, jobId }, "[training-export] could not mark job failed");
  }
}

/**
 * Resolve image bytes — local path first, Drive fallback. Mirrors the
 * pattern used by the image proxy and ml-runner.
 */
async function loadImageBytes(row: CandidateRow): Promise<Buffer> {
  if (row.imagePath) {
    try {
      return await fs.readFile(row.imagePath);
    } catch {
      // Fall through to Drive.
    }
  }
  if (!row.driveFileId) {
    throw new Error(
      `image ${row.imageId} (${row.filename}) has no local path and no driveFileId`,
    );
  }
  return await downloadFileToBuffer(row.driveFileId);
}

/**
 * Crop a normalized bbox out of an image with `cropPadding` padding, resize the
 * long edge to `cropLongEdge` px, and write at `jpegQuality`.
 *
 * Crash-safe + idempotent: a complete crop already on disk (size > 0) is reused
 * (so a retry after an interrupted export is fast), and a fresh crop is written
 * to a `.tmp` sibling then atomically renamed — so a process killed mid-encode
 * can never leave a truncated `.jpg` that a later run mistakes for done. The
 * single-flight guard guarantees no concurrent writer, so the exists-check is
 * race-free.
 */
async function cropAndWriteAtomic(
  buffer: Buffer,
  row: CandidateRow,
  outPath: string,
  quality: ExportQuality,
): Promise<void> {
  try {
    const st = await fs.stat(outPath);
    if (st.size > 0) return; // already written by a prior run
  } catch {
    // Not present — write it below.
  }

  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) {
    throw new Error("image has no dimensions");
  }
  const W = meta.width;
  const H = meta.height;

  // Apply padding around the bbox, then clamp to image bounds.
  const padW = row.bboxWidth * quality.cropPadding;
  const padH = row.bboxHeight * quality.cropPadding;
  const x0 = Math.max(0, row.bboxX - padW);
  const y0 = Math.max(0, row.bboxY - padH);
  const x1 = Math.min(1, row.bboxX + row.bboxWidth + padW);
  const y1 = Math.min(1, row.bboxY + row.bboxHeight + padH);

  const left = Math.max(0, Math.round(x0 * W));
  const top = Math.max(0, Math.round(y0 * H));
  let width = Math.max(1, Math.round((x1 - x0) * W));
  let height = Math.max(1, Math.round((y1 - y0) * H));
  // Clamp to bounds (rounding can push us 1px over).
  if (left + width > W) width = W - left;
  if (top + height > H) height = H - top;

  const tmpPath = `${outPath}.tmp`;
  await sharp(buffer)
    .extract({ left, top, width, height })
    .resize({
      width: quality.cropLongEdge,
      height: quality.cropLongEdge,
      fit: "inside",
      withoutEnlargement: false,
    })
    .jpeg({ quality: quality.jpegQuality })
    .toFile(tmpPath);
  await fs.rename(tmpPath, outPath);
}

export interface UploadDispatchResult {
  jobId: number;
}

/**
 * Dispatch a `training_export_upload` job: tar the export's version folder and
 * stream the .tar.gz to the shared Drive folder. Returns immediately with a
 * jobId; progress (indeterminate, phase via statusMessage) and cancellation
 * live on the job row and surface in the floating progress bar.
 */
export async function packageAndUploadExport(
  version: string,
): Promise<ActionResult<UploadDispatchResult>> {
  const user = await requireAdmin();

  // Strict allowlist on the DB key (defense-in-depth; the tar arg is the folder
  // basename derived from the stored manifestPath, run via execFile/no-shell).
  if (!/^v\d+$/.test(version)) {
    return { success: false, error: "Versión inválida." };
  }

  // The dataset must exist (don't archive arbitrary directories). It only
  // exists after the crop job's final insert, so this naturally blocks an
  // upload of a version that is still mid-export.
  const datasetRows = await db
    .select()
    .from(cameraTrapTrainingDatasets)
    .where(eq(cameraTrapTrainingDatasets.version, version))
    .limit(1);
  if (datasetRows.length === 0) {
    return { success: false, error: `No existe el exporte ${version}.` };
  }
  const dataset = datasetRows[0];

  // The real on-disk folder is the manifest's parent — works for both legacy
  // `vN` folders and the new `<date>-vN` scheme.
  const versionDir = path.dirname(dataset.manifestPath);
  try {
    const stat = await fs.stat(versionDir);
    if (!stat.isDirectory()) throw new Error("not a directory");
  } catch {
    return {
      success: false,
      error: `La carpeta del exporte ${version} no está en el disco. Es posible que haya que regenerarlo.`,
    };
  }

  // Atomic single-flight: one upload at a time.
  const jobRow = db.transaction((tx) => {
    const active = tx
      .select({ id: processingJobs.id })
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.jobType, JOB_TYPES.TRAINING_EXPORT_UPLOAD),
          inArray(processingJobs.status, ["pending", "processing"]),
        ),
      )
      .limit(1)
      .all();
    if (active.length > 0) return null;
    return tx
      .insert(processingJobs)
      .values({
        jobType: JOB_TYPES.TRAINING_EXPORT_UPLOAD,
        status: "processing",
        totalImages: 0,
        processedImages: 0,
        createdBy: user.email,
        startedAt: new Date(),
        statusMessage: "Preparando subida…",
      })
      .returning()
      .get() as ProcessingJob;
  });

  if (!jobRow) {
    return {
      success: false,
      error: "Ya hay una subida de exporte en curso. Espera a que termine.",
    };
  }

  await recordEvent(buildJobStartEvent(jobRow));

  void processTrainingExportUploadJobInternal(jobRow.id, dataset.id).catch(
    (err) => {
      void markExportJobFailed(jobRow.id, err);
    },
  );

  return { success: true, data: { jobId: jobRow.id } };
}

/**
 * Background tar + upload for a `training_export_upload` job. Tar runs into the
 * `data/` volume (not os.tmpdir() — a multi-GB archive could exhaust tmpfs) and
 * is removed in `finally`. Upload progress is indeterminate; phases are shown
 * via statusMessage. On cancel/failure the just-created Drive file is removed so
 * a partial upload can't orphan, and the prior good archive is never deleted.
 */
async function processTrainingExportUploadJobInternal(
  jobId: number,
  datasetId: number,
): Promise<void> {
  const startedAt = Date.now();
  let eventEmitted = false;
  const emitTerminal = async (extras?: Record<string, unknown>) => {
    if (eventEmitted) return;
    eventEmitted = true;
    const [latest] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId))
      .limit(1);
    if (latest) await recordEvent(buildJobCompletionEvent(latest, extras));
  };
  const isCancelled = async (): Promise<boolean> => {
    const [j] = await db
      .select({ status: processingJobs.status })
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId))
      .limit(1);
    return !j || j.status !== "processing";
  };

  let tarPath: string | null = null;
  let uploadedId: string | null = null;
  try {
    const [dataset] = await db
      .select()
      .from(cameraTrapTrainingDatasets)
      .where(eq(cameraTrapTrainingDatasets.id, datasetId))
      .limit(1);
    if (!dataset) throw new Error("El exporte ya no existe.");

    const versionDir = path.dirname(dataset.manifestPath);
    const folderName = path.basename(versionDir);
    const parentDir = path.dirname(versionDir);
    // Defensive allowlist on the folder name that goes into the tar arg.
    if (!/^(\d{4}-\d{2}-\d{2}-)?v\d+$/.test(folderName)) {
      throw new Error(`Nombre de carpeta inesperado: ${folderName}`);
    }

    await db
      .update(processingJobs)
      .set({ statusMessage: "Empaquetando archivo…" })
      .where(eq(processingJobs.id, jobId));

    log.info(
      { jobId, version: dataset.version, folderName },
      "[training-export] packaging archive",
    );
    tarPath = path.join(EXPORT_ROOT, `.upload-${folderName}.tar.gz`);
    // execFile (no shell). -C into the parent so the archive contains
    // `<folderName>/...` — extracting yields a folder matching the archive name.
    await execFileAsync(
      "tar",
      ["-czf", tarPath, "-C", parentDir, folderName],
      { maxBuffer: 1024 * 1024 },
    );

    if (await isCancelled()) {
      log.info({ jobId }, "[training-export] upload cancelled during tar");
      return;
    }

    await db
      .update(processingJobs)
      .set({ statusMessage: "Subiendo a Drive…" })
      .where(eq(processingJobs.id, jobId));

    const archiveName = `${folderName}.tar.gz`;
    const uploaded = await uploadLocalFileToSharedDrive(
      tarPath,
      archiveName,
      "application/gzip",
      TRAINING_EXPORT_DRIVE_FOLDER_ID,
    );
    uploadedId = uploaded.id;

    // Delete the prior archive (if any) so the folder doesn't accumulate stale
    // copies of the same version.
    if (
      dataset.driveArchiveFileId &&
      dataset.driveArchiveFileId !== uploaded.id
    ) {
      try {
        await deleteDriveFile(dataset.driveArchiveFileId);
      } catch (err) {
        log.warn(
          { err, fileId: dataset.driveArchiveFileId },
          "[training-export] could not delete prior archive (continuing)",
        );
      }
    }

    // Persist the link + complete the job atomically, guarded by status so a
    // last-instant cancel doesn't record a completed upload.
    const committed = db.transaction((tx) => {
      const [j] = tx
        .select({ status: processingJobs.status })
        .from(processingJobs)
        .where(eq(processingJobs.id, jobId))
        .limit(1)
        .all();
      if (!j || j.status !== "processing") return false;
      tx.update(cameraTrapTrainingDatasets)
        .set({
          driveArchiveFileId: uploaded.id,
          driveArchiveWebViewLink: uploaded.webViewLink,
          archiveUploadedAt: new Date(),
        })
        .where(eq(cameraTrapTrainingDatasets.id, datasetId))
        .run();
      tx.update(processingJobs)
        .set({
          status: "completed",
          completedAt: new Date(),
          statusMessage: null,
        })
        .where(eq(processingJobs.id, jobId))
        .run();
      return true;
    });

    if (!committed) {
      // Cancelled at finalize — remove the just-uploaded file so it doesn't orphan.
      if (uploadedId) await deleteDriveFile(uploadedId).catch(() => {});
      log.info({ jobId }, "[training-export] upload cancelled at finalize");
      return;
    }

    log.info(
      {
        jobId,
        version: dataset.version,
        sizeBytes: uploaded.size,
        elapsedMs: Date.now() - startedAt,
      },
      "[training-export] archive uploaded",
    );
    await emitTerminal({
      version: dataset.version,
      sizeBytes: uploaded.size,
      driveFileId: uploaded.id,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, jobId }, "[training-export] package/upload failed");
    // A partial/failed upload must not orphan a stray file in Drive.
    if (uploadedId) await deleteDriveFile(uploadedId).catch(() => {});
    await db
      .update(processingJobs)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorMessage: `No se pudo empaquetar/subir el exporte: ${msg}`,
        statusMessage: null,
      })
      .where(eq(processingJobs.id, jobId));
    await emitTerminal();
  } finally {
    if (tarPath) await fs.rm(tarPath, { force: true }).catch(() => {});
  }
}

/**
 * Cancel a `training_export` / `training_export_upload` job. Cooperative: flips
 * the row to `cancelled` (the running loop polls this) and emits the terminal
 * event. Idempotent — cancelling an already-terminal job is a no-op success.
 * These jobs have no subprocess (`pid` is null), so nothing to kill.
 */
export async function cancelTrainingExportJob(
  jobId: number,
): Promise<ActionResult<{ jobId: number }>> {
  await requirePermission("camera-trap", "editor");

  const [job] = await db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId))
    .limit(1);
  if (!job) {
    return { success: false, error: "Trabajo no encontrado." };
  }
  if (
    job.jobType !== JOB_TYPES.TRAINING_EXPORT &&
    job.jobType !== JOB_TYPES.TRAINING_EXPORT_UPLOAD
  ) {
    return { success: false, error: "Este trabajo no se cancela aquí." };
  }
  if (job.status !== "pending" && job.status !== "processing") {
    return { success: true, data: { jobId } }; // already terminal — no-op
  }

  await db
    .update(processingJobs)
    .set({ status: "cancelled", completedAt: new Date(), statusMessage: null })
    .where(eq(processingJobs.id, jobId));

  const [latest] = await db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId))
    .limit(1);
  if (latest) await recordEvent(buildJobCompletionEvent(latest));

  return { success: true, data: { jobId } };
}
