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
import sharp from "sharp";
import { eq, and, inArray, sql } from "drizzle-orm";

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
import { downloadFileToBuffer } from "@/lib/drive-client";
import {
  speciesSlug,
  assignSplit,
  computeContentHash,
  buildCounts,
  buildManifest,
  type HashRow,
  type Split,
} from "@/lib/training-export-helpers";

const EXPORT_ROOT = path.join(process.cwd(), "data", "training-exports");
const CROP_LONG_EDGE = 512;
const BBOX_PADDING = 0.05;
const JPEG_QUALITY = 90;
const DEFAULT_MIN_EXAMPLES = 50;

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
  slug: string;
  total: number;
  train: number;
  val: number;
  test: number;
}

export interface ExportPreview {
  minExamples: number;
  totalCandidates: number;
  classList: string[];
  droppedSpecies: Record<string, number>;
  perSpecies: ExportPreviewSpeciesRow[];
  deploymentCount: number;
  /** How many deployments would have a new train/val/test split persisted
   * on the next export. Zero means splits are already locked in for every
   * deployment with verified data. */
  newDeploymentSplits: number;
}

interface CandidateRow {
  detectionId: number;
  imageId: number;
  deploymentId: number;
  imagePath: string | null;
  driveFileId: string | null;
  filename: string;
  bboxX: number;
  bboxY: number;
  bboxWidth: number;
  bboxHeight: number;
  finalLabel: string;
}

interface CollectedCandidates {
  /** Filtered to only rows whose label is in classList. */
  filtered: CandidateRow[];
  classList: string[];
  droppedSpecies: Record<string, number>;
  splitByDeployment: Map<number, Split>;
  /** Deployments that did not yet have a persisted training_split when we
   * ran the query. exportTrainingDataset persists these in a sync
   * transaction; getExportPreview ignores them. */
  newAssignments: Array<{ id: number; split: Split }>;
  totalCandidatesBeforeFilter: number;
}

/**
 * Pure-read collection of export candidates. Shared by the preview and the
 * export server actions. Does NOT persist anything.
 */
async function collectExportCandidates(
  minExamples: number,
): Promise<CollectedCandidates> {
  // 1. Pull every verified animal detection joined with its identification
  //    and the parent image+deployment.
  const rawRows = await db
    .select({
      detectionId: detections.id,
      imageId: images.id,
      deploymentId: images.deploymentId,
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
      detectionClass: detections.detectionClass,
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
      ),
    );

  const candidates: CandidateRow[] = rawRows.map((r) => ({
    detectionId: r.detectionId,
    imageId: r.imageId,
    deploymentId: r.deploymentId,
    imagePath: r.imagePath,
    driveFileId: r.driveFileId,
    filename: r.filename,
    bboxX: r.bboxX,
    bboxY: r.bboxY,
    bboxWidth: r.bboxWidth,
    bboxHeight: r.bboxHeight,
    finalLabel: (r.correctedSpecies ?? r.species ?? "").trim(),
  }));

  // 2. Group by label, drop labels below threshold.
  const labelCounts = new Map<string, number>();
  for (const c of candidates) {
    if (!c.finalLabel) continue;
    labelCounts.set(c.finalLabel, (labelCounts.get(c.finalLabel) ?? 0) + 1);
  }
  const classList: string[] = [];
  const droppedSpecies: Record<string, number> = {};
  for (const [label, count] of labelCounts) {
    if (count >= minExamples) classList.push(label);
    else droppedSpecies[label] = count;
  }
  classList.sort();

  const classListSet = new Set(classList);
  const filtered = candidates.filter(
    (c) => c.finalLabel && classListSet.has(c.finalLabel),
  );

  // 3. Resolve training_split per deployment — read existing, compute for
  //    any that don't have one yet. This is pure read: we do NOT persist
  //    newAssignments here. The export path writes them inside its own
  //    transaction.
  const splitByDeployment = new Map<number, Split>();
  const newAssignments: Array<{ id: number; split: Split }> = [];

  const deploymentIds = Array.from(
    new Set(filtered.map((c) => c.deploymentId)),
  );
  if (deploymentIds.length > 0) {
    const existingSplits = await db
      .select({ id: deployments.id, trainingSplit: deployments.trainingSplit })
      .from(deployments)
      .where(inArray(deployments.id, deploymentIds));

    for (const dep of existingSplits) {
      if (
        dep.trainingSplit === "train" ||
        dep.trainingSplit === "val" ||
        dep.trainingSplit === "test"
      ) {
        splitByDeployment.set(dep.id, dep.trainingSplit);
      } else {
        const split = assignSplit(dep.id);
        splitByDeployment.set(dep.id, split);
        newAssignments.push({ id: dep.id, split });
      }
    }
  }

  return {
    filtered,
    classList,
    droppedSpecies,
    splitByDeployment,
    newAssignments,
    totalCandidatesBeforeFilter: candidates.length,
  };
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
): Promise<ActionResult<ExportPreview>> {
  await requireAdmin();

  if (!Number.isFinite(minExamples) || minExamples < 1) {
    return { success: false, error: "minExamples must be a positive integer" };
  }

  try {
    const collected = await collectExportCandidates(minExamples);

    // Aggregate per-label-per-split counts for display.
    const perLabelCounts = new Map<
      string,
      { train: number; val: number; test: number }
    >();
    for (const row of collected.filtered) {
      const split = collected.splitByDeployment.get(row.deploymentId);
      if (!split) continue;
      const existing = perLabelCounts.get(row.finalLabel) ?? {
        train: 0,
        val: 0,
        test: 0,
      };
      existing[split] += 1;
      perLabelCounts.set(row.finalLabel, existing);
    }

    const perSpecies: ExportPreviewSpeciesRow[] = Array.from(
      perLabelCounts.entries(),
    )
      .map(([label, splitCounts]) => ({
        label,
        slug: speciesSlug(label),
        total: splitCounts.train + splitCounts.val + splitCounts.test,
        train: splitCounts.train,
        val: splitCounts.val,
        test: splitCounts.test,
      }))
      .sort((a, b) => b.total - a.total);

    const deploymentCount = collected.splitByDeployment.size;

    return {
      success: true,
      data: {
        minExamples,
        totalCandidates: collected.totalCandidatesBeforeFilter,
        classList: collected.classList,
        droppedSpecies: collected.droppedSpecies,
        perSpecies,
        deploymentCount,
        newDeploymentSplits: collected.newAssignments.length,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[training-export] preview failed:", err);
    return { success: false, error: msg };
  }
}

/**
 * Server action — export a versioned training dataset.
 *
 * Required form field: `minExamples` (integer, defaults to 50).
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

  try {
    const collected = await collectExportCandidates(minExamples);

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
    } = collected;

    // Persist the new write-once split assignments BEFORE computing the hash,
    // so a re-run that includes the same deployments produces the same hash.
    if (newAssignments.length > 0) {
      db.transaction((tx) => {
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

    // Crop every kept detection to disk.
    const warnings: string[] = [];
    let written = 0;

    console.log(
      `[training-export] starting export ${version}: ${filtered.length} crops, ${classList.length} classes`,
    );
    const startedAt = Date.now();

    for (const row of filtered) {
      const split = splitByDeployment.get(row.deploymentId)!;
      const slug = speciesSlug(row.finalLabel);
      const outDir = path.join(versionDir, split, slug);
      const outPath = path.join(outDir, `${row.detectionId}.jpg`);

      try {
        await fs.mkdir(outDir, { recursive: true });
        const buffer = await loadImageBytes(row);
        await cropAndWrite(buffer, row, outPath);
        written += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`detection ${row.detectionId}: ${msg}`);
        if (warnings.length <= 5) {
          console.warn(
            `[training-export] crop failed for detection ${row.detectionId}: ${msg}`,
          );
        }
      }

      if (written > 0 && written % 200 === 0) {
        const elapsed = (Date.now() - startedAt) / 1000;
        const rate = written / elapsed;
        const eta = Math.round((filtered.length - written) / rate);
        console.log(
          `[training-export] ${written}/${filtered.length} crops (${rate.toFixed(1)}/s, ETA ${eta}s)`,
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
      classList: classList.map((label) => speciesSlug(label)),
      droppedSpecies,
      counts,
      deployments: deploymentSummaries,
      warnings,
    });

    const manifestPath = path.join(versionDir, "manifest.json");
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

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
            classList.map((label) => speciesSlug(label)),
          ),
          droppedSpeciesJson: JSON.stringify(droppedSpecies),
          deploymentsJson: JSON.stringify(deploymentSummaries),
          manifestPath,
        })
        .returning()
        .get() as CameraTrapTrainingDataset;
    });

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `[training-export] done ${version} in ${elapsed}s — ${written}/${filtered.length} crops written, ${classList.length} classes, ${warnings.length} warnings`,
    );

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
    console.error("[training-export] failed:", err);
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
 * Crop a normalized bbox out of an image with 5% padding, resize the long
 * edge to 512px, and write JPEG quality 90.
 */
async function cropAndWrite(
  buffer: Buffer,
  row: CandidateRow,
  outPath: string,
): Promise<void> {
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) {
    throw new Error("image has no dimensions");
  }
  const W = meta.width;
  const H = meta.height;

  // Apply 5% padding around the bbox, then clamp to image bounds.
  const padW = row.bboxWidth * BBOX_PADDING;
  const padH = row.bboxHeight * BBOX_PADDING;
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
      width: CROP_LONG_EDGE,
      height: CROP_LONG_EDGE,
      fit: "inside",
      withoutEnlargement: false,
    })
    .jpeg({ quality: JPEG_QUALITY })
    .toFile(outPath);
}
