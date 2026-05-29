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
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { eq, and, inArray, gte, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  detections,
  images,
  identifications,
  deployments,
  cameraTrapTrainingDatasets,
  type CameraTrapTrainingDataset,
} from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import type { ActionResult } from "@/lib/types";
import {
  downloadFileToBuffer,
  uploadLocalFileToSharedDrive,
  deleteDriveFile,
} from "@/lib/drive-client";
import { ML_DEFAULTS } from "@/lib/ml-defaults";
import { recordEvent } from "@/lib/system-events";
import { log } from "@/lib/log";
import {
  speciesFolderName,
  computeContentHash,
  buildCounts,
  buildManifest,
  buildCropsCsv,
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

/** Crop-quality + confidence knobs for an export. */
type ExportQuality = QualityParams;

const DEFAULT_QUALITY: ExportQuality = {
  detectionConfidenceFloor: MIN_CONFIDENCE_FLOOR,
  cropPadding: BBOX_PADDING,
  cropLongEdge: CROP_LONG_EDGE,
  jpegQuality: JPEG_QUALITY,
};

export interface ExportResult {
  datasetId: number;
  version: string;
  status: "created" | "unchanged";
  imageCount: number;
  classCount: number;
  droppedSpecies: Record<string, number>;
  warnings: string[];
}

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
): Promise<ActionResult<ExportResult>> {
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
        data: {
          datasetId: row.id,
          version: row.version,
          status: "unchanged",
          imageCount: row.imageCount,
          classCount: row.classCount,
          droppedSpecies: JSON.parse(row.droppedSpeciesJson),
          warnings: [],
        },
      };
    }

    // Compute next monotonic version.
    const maxIdRow = await db
      .select({ maxId: sql<number | null>`max(id)` })
      .from(cameraTrapTrainingDatasets);
    const nextNum = (maxIdRow[0]?.maxId ?? 0) + 1;
    const version = `v${nextNum}`;

    const versionDir = path.join(EXPORT_ROOT, version);
    await fs.mkdir(versionDir, { recursive: true });

    // Crop every kept detection to disk. crops.csv gets one row per crop that
    // actually lands on disk (failed crops are excluded, matching the files).
    const warnings: string[] = [];
    const csvRows: CropCsvRow[] = [];
    let written = 0;

    log.info(
      { version, crops: filtered.length, classes: classList.length },
      "[training-export] starting export",
    );
    const startedAt = Date.now();

    for (const row of filtered) {
      const split = splitByDeployment.get(row.deploymentId)!;
      const folderName = speciesFolderName(row.finalLabel);
      const outDir = path.join(versionDir, split, folderName);
      const outPath = path.join(outDir, `${row.detectionId}.jpg`);

      try {
        await fs.mkdir(outDir, { recursive: true });
        const buffer = await loadImageBytes(row);
        await cropAndWrite(buffer, row, outPath, quality);
        written += 1;
        csvRows.push({
          // POSIX-style relative path (forward slashes) regardless of OS.
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
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`detection ${row.detectionId}: ${msg}`);
        if (warnings.length <= 5) {
          log.warn(
            { detectionId: row.detectionId, err: msg },
            "[training-export] crop failed for detection",
          );
        }
      }

      if (written > 0 && written % 200 === 0) {
        const elapsed = (Date.now() - startedAt) / 1000;
        const rate = written / elapsed;
        const eta = Math.round((filtered.length - written) / rate);
        log.info(
          { written, total: filtered.length, ratePerSec: +rate.toFixed(1), etaSec: eta },
          "[training-export] progress",
        );
      }
    }

    // Build manifest + per-deployment counts.
    const counts = buildCounts(
      filtered.map((c) => ({
        finalLabel: c.finalLabel,
        split: splitByDeployment.get(c.deploymentId)!,
      })),
    );

    const perDeploymentCounts = new Map<number, number>();
    for (const c of filtered) {
      perDeploymentCounts.set(
        c.deploymentId,
        (perDeploymentCounts.get(c.deploymentId) ?? 0) + 1,
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
      createdAt: new Date(),
      createdBy: user.email,
      minExamplesThreshold: minExamples,
      classList: classList.map((label) => speciesFolderName(label)),
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

    // Per-crop provenance CSV (one row per crop on disk) for ML consumers.
    const cropsCsvPath = path.join(versionDir, "crops.csv");
    await fs.writeFile(
      cropsCsvPath,
      buildCropsCsv(csvRows, {
        cropPadding: quality.cropPadding,
        cropLongEdge: quality.cropLongEdge,
        jpegQuality: quality.jpegQuality,
      }),
    );

    // Insert the dataset row in a synchronous transaction.
    const datasetRow = db.transaction((tx) => {
      return tx
        .insert(cameraTrapTrainingDatasets)
        .values({
          version,
          contentHash,
          createdBy: user.email,
          imageCount: written,
          classCount: classList.length,
          minExamplesThreshold: minExamples,
          classListJson: JSON.stringify(
            classList.map((label) => speciesFolderName(label)),
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
    });

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    log.info(
      {
        version,
        elapsedSec: elapsed,
        written,
        total: filtered.length,
        classes: classList.length,
        warnings: warnings.length,
      },
      "[training-export] done",
    );

    await recordEvent({
      source: "camera-trap",
      eventType: "training_export.completed",
      summary: `Exporte de entrenamiento ${version} creado — ${written} recortes, ${classList.length} clases`,
      actorEmail: user.email,
      targetType: "training_dataset",
      targetId: datasetRow.id,
      durationMs: Date.now() - startedAt,
      details: {
        version,
        imageCount: written,
        classCount: classList.length,
        minExamples,
        detectionConfidenceFloor: quality.detectionConfidenceFloor,
        cropPadding: quality.cropPadding,
        cropLongEdge: quality.cropLongEdge,
        jpegQuality: quality.jpegQuality,
        warnings: warnings.length,
      },
    });

    return {
      success: true,
      data: {
        datasetId: datasetRow.id,
        version,
        status: "created",
        imageCount: written,
        classCount: classList.length,
        droppedSpecies,
        warnings,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, "[training-export] failed");
    return { success: false, error: msg };
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
 */
async function cropAndWrite(
  buffer: Buffer,
  row: CandidateRow,
  outPath: string,
  quality: ExportQuality,
): Promise<void> {
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

  await sharp(buffer)
    .extract({ left, top, width, height })
    .resize({
      width: quality.cropLongEdge,
      height: quality.cropLongEdge,
      fit: "inside",
      withoutEnlargement: false,
    })
    .jpeg({ quality: quality.jpegQuality })
    .toFile(outPath);
}

export interface UploadArchiveResult {
  version: string;
  webViewLink: string;
  sizeBytes: number;
}

/**
 * Package a training-export version folder into a .tar.gz and upload it to the
 * shared Drive folder so it can be downloaded/shared with collaborators.
 *
 * Streams the archive from disk (never buffers it in memory) and stores the
 * resulting webViewLink on the dataset row. The archive inherits the Shared
 * Drive's membership — there is no public link sharing.
 */
export async function packageAndUploadExport(
  version: string,
): Promise<ActionResult<UploadArchiveResult>> {
  const user = await requireAdmin();

  // Strict allowlist — `version` is interpolated into a tar arg and a path.
  if (!/^v\d+$/.test(version)) {
    return { success: false, error: "Versión inválida." };
  }

  // The dataset must exist in the DB (don't archive arbitrary directories).
  const datasetRows = await db
    .select()
    .from(cameraTrapTrainingDatasets)
    .where(eq(cameraTrapTrainingDatasets.version, version))
    .limit(1);
  if (datasetRows.length === 0) {
    return { success: false, error: `No existe el exporte ${version}.` };
  }
  const dataset = datasetRows[0];

  const versionDir = path.join(EXPORT_ROOT, version);
  try {
    const stat = await fs.stat(versionDir);
    if (!stat.isDirectory()) throw new Error("not a directory");
  } catch {
    return {
      success: false,
      error: `La carpeta del exporte ${version} no está en el disco. Es posible que haya que regenerarlo.`,
    };
  }

  // Build the archive in the OS temp dir (cleaned up in finally).
  const tarPath = path.join(os.tmpdir(), `training-export-${version}.tar.gz`);
  const startedAt = Date.now();

  try {
    log.info({ version, tarPath }, "[training-export] packaging archive");
    // execFile (not exec) — no shell, so `version` cannot inject. -C changes
    // into EXPORT_ROOT so the archive contains `<version>/...` paths.
    await execFileAsync(
      "tar",
      ["-czf", tarPath, "-C", EXPORT_ROOT, version],
      { maxBuffer: 1024 * 1024 },
    );

    // Date-prefix the Drive filename so archives sort chronologically in the
    // Drive folder (avoids the lexical v1/v10/v2 interleave). The prefix is the
    // export's creation date (stable across re-uploads), e.g. 2026-05-28-v10.tar.gz.
    const datePrefix = dataset.createdAt.toISOString().slice(0, 10);
    const archiveName = `${datePrefix}-${version}.tar.gz`;

    const uploaded = await uploadLocalFileToSharedDrive(
      tarPath,
      archiveName,
      "application/gzip",
      TRAINING_EXPORT_DRIVE_FOLDER_ID,
    );

    // If a prior archive existed, delete it so the folder doesn't accumulate
    // stale copies of the same version.
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

    db.update(cameraTrapTrainingDatasets)
      .set({
        driveArchiveFileId: uploaded.id,
        driveArchiveWebViewLink: uploaded.webViewLink,
        archiveUploadedAt: new Date(),
      })
      .where(eq(cameraTrapTrainingDatasets.id, dataset.id))
      .run();

    await recordEvent({
      source: "camera-trap",
      eventType: "training_export.uploaded",
      summary: `Exporte de entrenamiento ${version} empaquetado y subido a Drive`,
      actorEmail: user.email,
      targetType: "training_dataset",
      targetId: dataset.id,
      durationMs: Date.now() - startedAt,
      details: {
        version,
        sizeBytes: uploaded.size,
        driveFileId: uploaded.id,
      },
    });

    log.info(
      { version, sizeBytes: uploaded.size, elapsedMs: Date.now() - startedAt },
      "[training-export] archive uploaded",
    );

    return {
      success: true,
      data: {
        version,
        webViewLink: uploaded.webViewLink,
        sizeBytes: uploaded.size,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, version }, "[training-export] package/upload failed");
    return {
      success: false,
      error: `No se pudo empaquetar/subir el exporte: ${msg}`,
    };
  } finally {
    await fs.rm(tarPath, { force: true }).catch(() => {});
  }
}
