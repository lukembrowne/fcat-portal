"use server";

/**
 * Camera trap custom-classifier model registry.
 *
 * Models are not uploaded through the portal — an admin SCPs a directory
 * into data/models/<version>/ containing weights.pt, metrics.json,
 * class_mapping.json, and confusion_matrix.csv (contract v2), then clicks
 * Register here.
 *
 * Validation rules at registration time are deliberately strict — silent
 * class drift between training and inference is catastrophic, so we
 * hard-fail on any contract mismatch unless the admin explicitly checks
 * "allow untracked dataset".
 *
 * Security hardening (see docs/plans/2026-05-22-feat-camera-trap-model-comparison-plan.md
 * Security Considerations table):
 *   - dirName allowlist + no leading dot
 *   - lstat on each file (reject symlinks)
 *   - realpath assertion against MODELS_ROOT
 *   - pre-parse file-size caps
 *   - class-name shape regex (defense in depth via Zod schema)
 *   - SHA-256 audit hashes in recordEvent
 */

import { createHash } from "node:crypto";
import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";

import { eq, and, ne, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  cameraTrapModelClassMetrics,
  cameraTrapModels,
  cameraTrapTrainingDatasets,
  processingJobs,
  species,
  type CameraTrapModel,
} from "@/db/schema";
import { requireAdmin, requirePermission } from "@/lib/auth";
import { recordEvent } from "@/lib/system-events";
import type { ActionResult } from "@/lib/types";
import { shutdownModelServer } from "@/lib/ml-runner";
import { ML_DEFAULTS } from "@/lib/ml-defaults";
import { log } from "@/lib/log";

import { type ImportError, importErrorToSpanish } from "./import-errors";
import {
  type MetricsV2,
  MetricsV2Schema,
  looksLikeV1Contract,
} from "./metrics-schema";
import {
  parseConfusionMatrixCsv,
  type ParsedConfusionMatrix,
} from "./parse-confusion-matrix";

const MODELS_ROOT = path.join(process.cwd(), "data", "models");

const DIR_NAME_REGEX = /^[A-Za-z0-9._-]+$/;

const FILE_SIZE_LIMITS = {
  "metrics.json": 1_000_000,
  "class_mapping.json": 256_000,
  "confusion_matrix.csv": 500_000,
} as const;

export interface UnregisteredModelDir {
  dirName: string;
  hasWeights: boolean;
  hasMetrics: boolean;
  hasClassMapping: boolean;
  hasConfusionMatrix: boolean;
}

/**
 * Scan data/models/ for subdirectories not yet present in the registry.
 * Reports which expected files exist for each so the UI can flag broken
 * directories before the admin clicks Register.
 */
export async function listUnregisteredModelDirs(): Promise<
  UnregisteredModelDir[]
> {
  await requireAdmin();
  return scanUnregisteredDirs();
}

async function scanUnregisteredDirs(): Promise<UnregisteredModelDir[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(MODELS_ROOT);
  } catch {
    // Directory doesn't exist yet — no unregistered models.
    return [];
  }

  const registered = await db
    .select({ modelDir: cameraTrapModels.modelDir })
    .from(cameraTrapModels);
  const registeredDirs = new Set(
    registered.map((r) => path.basename(r.modelDir)),
  );

  const result: UnregisteredModelDir[] = [];
  for (const entry of entries) {
    if (registeredDirs.has(entry)) continue;
    const fullPath = path.join(MODELS_ROOT, entry);
    let stat;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    result.push({
      dirName: entry,
      hasWeights: await fileExists(path.join(fullPath, "weights.pt")),
      hasMetrics: await fileExists(path.join(fullPath, "metrics.json")),
      hasClassMapping: await fileExists(
        path.join(fullPath, "class_mapping.json"),
      ),
      hasConfusionMatrix: await fileExists(
        path.join(fullPath, "confusion_matrix.csv"),
      ),
    });
  }
  return result.sort((a, b) => a.dirName.localeCompare(b.dirName));
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * Register a model directory. Validates the metrics.json contract v2,
 * cross-checks class_mapping ↔ classListOrdered, parses confusion_matrix.csv,
 * and (unless overridden) verifies the training dataset hash exists in the
 * registry.
 */
export async function registerModelFromDir(
  formData: FormData,
): Promise<
  ActionResult<{
    modelId: number;
    version: string;
    /** Class names from the uploaded class_mapping.json that do not match
     * any biochoco_species.scientificName. Detections from such classes
     * won't link to the species table (no English/Spanish name, won't
     * aggregate with hand-annotated detections). Empty array means the
     * model's classes are fully covered. */
    unmatchedClasses: string[];
  }>
> {
  const user = await requireAdmin();

  const dirNameRaw = formData.get("dirName");
  const allowUntracked = formData.get("allowUntracked") === "on";
  if (typeof dirNameRaw !== "string" || dirNameRaw.length === 0) {
    return { success: false, error: "dirName is required" };
  }
  const dirName = dirNameRaw;

  const result = await tryRegister(dirName, allowUntracked, user.email);
  if (result.ok) {
    return { success: true, data: result.value };
  }

  // Record the rejection for forensic visibility.
  await recordEvent({
    source: "camera-trap",
    eventType: "ct_model.register_failed",
    summary: `Registro de modelo CT rechazado · ${dirName}`,
    severity: "warn",
    actorEmail: user.email,
    projectId: "camera-trap",
    targetType: "camera_trap_model_dir",
    targetId: null,
    details: {
      dirName,
      allowUntracked,
      error: result.error,
    },
  });
  log.warn({ dirName, error: result.error }, "[ct-models] register rejected");

  return { success: false, error: importErrorToSpanish(result.error) };
}

type Ok<T> = { ok: true; value: T };
type Err = { ok: false; error: ImportError };

async function tryRegister(
  dirName: string,
  allowUntracked: boolean,
  actorEmail: string,
): Promise<
  | Ok<{ modelId: number; version: string; unmatchedClasses: string[] }>
  | Err
> {
  // --- Path-safety: allowlist + no leading dot + realpath check ------------
  if (!DIR_NAME_REGEX.test(dirName) || dirName.startsWith(".")) {
    return { ok: false, error: { kind: "invalid_dir_name", dirName } };
  }
  const modelDir = path.join(MODELS_ROOT, dirName);
  try {
    const real = await fs.realpath(modelDir);
    if (
      real !== MODELS_ROOT &&
      !real.startsWith(MODELS_ROOT + path.sep)
    ) {
      return { ok: false, error: { kind: "invalid_dir_name", dirName } };
    }
  } catch {
    return { ok: false, error: { kind: "missing_file", file: "metrics.json" } };
  }

  const weightsPath = path.join(modelDir, "weights.pt");
  const metricsPath = path.join(modelDir, "metrics.json");
  const classMappingPath = path.join(modelDir, "class_mapping.json");
  const confusionMatrixPath = path.join(modelDir, "confusion_matrix.csv");

  // --- Existence + symlink rejection + size cap for each file --------------
  const weightsCheck = await checkArtifact(weightsPath, "weights.pt", null);
  if (!weightsCheck.ok) return weightsCheck;

  const metricsCheck = await checkArtifact(
    metricsPath,
    "metrics.json",
    FILE_SIZE_LIMITS["metrics.json"],
  );
  if (!metricsCheck.ok) return metricsCheck;

  const classMappingCheck = await checkArtifact(
    classMappingPath,
    "class_mapping.json",
    FILE_SIZE_LIMITS["class_mapping.json"],
  );
  if (!classMappingCheck.ok) return classMappingCheck;

  const cmCheck = await checkArtifact(
    confusionMatrixPath,
    "confusion_matrix.csv",
    FILE_SIZE_LIMITS["confusion_matrix.csv"],
  );
  if (!cmCheck.ok) return cmCheck;

  // --- Hash weights (streamed) ---------------------------------------------
  // BioCLIP weights.pt is ~2.5 GB; never slurp the whole file into one Buffer.
  // Streaming keeps registration memory flat regardless of model size.
  const weightsSha256 = await sha256File(weightsPath);

  // --- Parse metrics.json --------------------------------------------------
  const metricsRaw = await fs.readFile(metricsPath, "utf-8");
  let metricsJsonValue: unknown;
  try {
    metricsJsonValue = JSON.parse(metricsRaw);
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: "invalid_json",
        file: "metrics.json",
        detail: (err as Error).message,
      },
    };
  }
  if (looksLikeV1Contract(metricsJsonValue)) {
    return {
      ok: false,
      error: { kind: "contract_version_unsupported", got: "v1 (legacy)" },
    };
  }
  const parsed = MetricsV2Schema.safeParse(metricsJsonValue);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const detail = `${first.path.join(".") || "<root>"}: ${first.message}`;
    return { ok: false, error: { kind: "schema_violation", detail } };
  }
  const metrics: MetricsV2 = parsed.data;

  // --- v3 integrity: verify weights against the producer-emitted hash -------
  // A computed-but-unverified hash catches nothing. The producer (classifier
  // train.py) emits "sha256:<hex>"; comparing it here turns a truncated scp of
  // the 2.5 GB weights into a clean registration error instead of a strict-load
  // explosion (or silent garbage predictions) at serve time. v2 omits the field.
  if (metrics.weightsSha256) {
    const expected = metrics.weightsSha256.replace(/^sha256:/, "");
    if (expected !== weightsSha256) {
      return {
        ok: false,
        error: { kind: "weights_hash_mismatch", expected, got: weightsSha256 },
      };
    }
  }

  const metricsSha256 = sha256Hex(Buffer.from(metricsRaw));

  // --- Parse class_mapping.json --------------------------------------------
  const classMappingRaw = await fs.readFile(classMappingPath, "utf-8");
  let classMapping: unknown;
  try {
    classMapping = JSON.parse(classMappingRaw);
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: "invalid_json",
        file: "class_mapping.json",
        detail: (err as Error).message,
      },
    };
  }
  if (
    !Array.isArray(classMapping) ||
    !classMapping.every((s): s is string => typeof s === "string")
  ) {
    return {
      ok: false,
      error: {
        kind: "schema_violation",
        detail: "class_mapping.json must be a JSON array of strings",
      },
    };
  }
  if (classMapping.length !== metrics.classListOrdered.length) {
    return {
      ok: false,
      error: {
        kind: "class_count_mismatch",
        classMappingCount: classMapping.length,
        classListOrderedCount: metrics.classListOrdered.length,
      },
    };
  }
  for (let i = 0; i < classMapping.length; i++) {
    if (classMapping[i] !== metrics.classListOrdered[i]) {
      return {
        ok: false,
        error: {
          kind: "class_alignment_mismatch",
          index: i,
          classMapping: classMapping[i],
          classListOrdered: metrics.classListOrdered[i],
        },
      };
    }
  }

  // --- perClass keys must exactly match classListOrdered -------------------
  const perClassKeys = new Set(Object.keys(metrics.perClass));
  for (const cls of metrics.classListOrdered) {
    if (!perClassKeys.has(cls)) {
      return {
        ok: false,
        error: {
          kind: "schema_violation",
          detail: `perClass missing entry for "${cls}"`,
        },
      };
    }
  }
  if (perClassKeys.size !== metrics.classListOrdered.length) {
    return {
      ok: false,
      error: {
        kind: "schema_violation",
        detail: `perClass has ${perClassKeys.size} entries, classListOrdered has ${metrics.classListOrdered.length}`,
      },
    };
  }

  // --- Parse confusion_matrix.csv ------------------------------------------
  const csvText = await fs.readFile(confusionMatrixPath, "utf-8");
  const cmResult = parseConfusionMatrixCsv(csvText, metrics.classListOrdered);
  if (!cmResult.ok) return cmResult;
  const confusionMatrix: ParsedConfusionMatrix = cmResult.value;

  // --- Training dataset provenance -----------------------------------------
  const expectedHash = metrics.trainingDatasetContentHash.replace(
    /^sha256:/,
    "",
  );
  const datasetMatch = await db
    .select({ id: cameraTrapTrainingDatasets.id })
    .from(cameraTrapTrainingDatasets)
    .where(eq(cameraTrapTrainingDatasets.contentHash, expectedHash))
    .limit(1);
  let trainingDatasetId: number | null = null;
  if (datasetMatch.length > 0) {
    trainingDatasetId = datasetMatch[0].id;
  } else if (!allowUntracked) {
    return {
      ok: false,
      error: { kind: "unknown_training_dataset", contentHash: expectedHash },
    };
  }

  // --- Non-fatal: flag class names not in biochoco_species -----------------
  const allSpecies = await db
    .select({ scientificName: species.scientificName })
    .from(species);
  const known = new Set(allSpecies.map((s) => s.scientificName));
  const unmatchedClasses = classMapping.filter((c) => !known.has(c));

  // --- Transactional insert with race-safe uniqueness + COUNT assertion ----
  const confusionMatrixJson = JSON.stringify({
    classes: confusionMatrix.classes,
    matrix: confusionMatrix.matrix,
    axisConvention: confusionMatrix.axisConvention,
  });

  const perClassRows = metrics.classListOrdered.map((cls) => {
    const pc = metrics.perClass[cls];
    return {
      className: cls,
      precisionValue: Number.isFinite(pc.precision) ? pc.precision : null,
      recall: Number.isFinite(pc.recall) ? pc.recall : null,
      f1: Number.isFinite(pc.f1) ? pc.f1 : null,
      support: pc.support,
      trainCount: pc.trainCount,
    };
  });

  let inserted: CameraTrapModel;
  try {
    inserted = db.transaction((tx) => {
      // Move the duplicate-version check inside the transaction so two
      // concurrent registers can't both pass the pre-check.
      const dupe = tx
        .select({ id: cameraTrapModels.id })
        .from(cameraTrapModels)
        .where(eq(cameraTrapModels.version, metrics.modelVersion))
        .limit(1)
        .all();
      if (dupe.length > 0) {
        throw new DuplicateVersionError(metrics.modelVersion);
      }

      const row = tx
        .insert(cameraTrapModels)
        .values({
          version: metrics.modelVersion,
          modelDir,
          classMappingJson: classMappingRaw,
          metricsJson: metricsRaw,
          confusionMatrixJson,
          confidenceThreshold: metrics.recommendedConfidenceThreshold,
          trainingDatasetId,
          active: false,
          createdBy: actorEmail,
        })
        .returning()
        .get() as CameraTrapModel;

      tx.insert(cameraTrapModelClassMetrics)
        .values(perClassRows.map((r) => ({ ...r, modelId: row.id })))
        .run();

      // Defensive: assert the per-class rows landed before committing.
      const count = tx
        .select({ n: sql<number>`COUNT(*)` })
        .from(cameraTrapModelClassMetrics)
        .where(eq(cameraTrapModelClassMetrics.modelId, row.id))
        .get();
      if (!count || count.n !== metrics.classListOrdered.length) {
        throw new Error(
          `internal: inserted ${count?.n ?? 0} class-metric rows, expected ${metrics.classListOrdered.length}`,
        );
      }

      return row;
    });
  } catch (err) {
    if (err instanceof DuplicateVersionError) {
      return {
        ok: false,
        error: { kind: "duplicate_version", version: err.version },
      };
    }
    throw err;
  }

  await recordEvent({
    source: "camera-trap",
    eventType: "ct_model.register",
    summary: `Modelo CT registrado · ${inserted.version}`,
    actorEmail,
    projectId: "camera-trap",
    targetType: "camera_trap_model",
    targetId: inserted.id,
    details: {
      version: inserted.version,
      modelDir,
      contractVersion: "v2",
      backbone: metrics.backbone,
      recommendedConfidenceThreshold: metrics.recommendedConfidenceThreshold,
      classCount: metrics.classListOrdered.length,
      trainingDatasetId,
      trainingDatasetContentHash: expectedHash,
      allowUntracked,
      unmatchedClassCount: unmatchedClasses.length,
      weightsSha256,
      metricsSha256,
    },
  });

  if (unmatchedClasses.length > 0) {
    log.warn(
      {
        modelId: inserted.id,
        version: inserted.version,
        unmatchedCount: unmatchedClasses.length,
        sample: unmatchedClasses.slice(0, 10),
      },
      "[ct-models] registered model has classes missing from biochoco_species",
    );
  }

  return {
    ok: true,
    value: {
      modelId: inserted.id,
      version: inserted.version,
      unmatchedClasses,
    },
  };
}

class DuplicateVersionError extends Error {
  constructor(public readonly version: string) {
    super(`duplicate version: ${version}`);
  }
}

async function checkArtifact(
  filePath: string,
  artifactName:
    | "weights.pt"
    | "metrics.json"
    | "confusion_matrix.csv"
    | "class_mapping.json",
  maxBytes: number | null,
): Promise<Ok<null> | Err> {
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch {
    return { ok: false, error: { kind: "missing_file", file: artifactName } };
  }
  if (stat.isSymbolicLink()) {
    return { ok: false, error: { kind: "symlink_rejected", file: artifactName } };
  }
  if (!stat.isFile()) {
    return { ok: false, error: { kind: "missing_file", file: artifactName } };
  }
  if (stat.size === 0) {
    return { ok: false, error: { kind: "empty_file", file: artifactName } };
  }
  if (maxBytes !== null && stat.size > maxBytes) {
    return {
      ok: false,
      error: {
        kind: "file_too_large",
        file: artifactName,
        sizeBytes: stat.size,
        maxBytes,
      },
    };
  }
  return { ok: true, value: null };
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Stream a file through SHA-256. Used for weights.pt, which is ~2.5 GB for a
 * BioCLIP model — reading it into a single Buffer (fs.readFile) would spike
 * memory and risk Node's max-Buffer limit. Returns bare hex (no "sha256:").
 */
async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

/**
 * Activate a model. Refuses if any ML processing job is currently running.
 * Triggers shutdownModelServer() so the next spawn picks up the new env vars.
 */
export async function setActiveModel(
  formData: FormData,
): Promise<ActionResult<{ modelId: number }>> {
  const user = await requireAdmin();

  const modelIdRaw = formData.get("modelId");
  const modelId =
    typeof modelIdRaw === "string" ? Number.parseInt(modelIdRaw, 10) : NaN;
  if (!Number.isFinite(modelId)) {
    return { success: false, error: "modelId is required" };
  }

  try {
    const target = await db
      .select()
      .from(cameraTrapModels)
      .where(eq(cameraTrapModels.id, modelId))
      .limit(1);
    if (target.length === 0) {
      return { success: false, error: `model ${modelId} not found` };
    }

    // Refuse while an ML job is running. Statuses 'pending' and 'processing'
    // both mean the model server may be loaded — block both.
    const inFlight = await db
      .select({ id: processingJobs.id })
      .from(processingJobs)
      .where(
        and(
          inArray(processingJobs.status, ["pending", "processing"]),
          eq(processingJobs.jobType, "ml"),
        ),
      )
      .limit(1);
    if (inFlight.length > 0) {
      return {
        success: false,
        error: `hay un trabajo de ML en progreso (id=${inFlight[0].id}). Esperá a que termine antes de cambiar el modelo activo.`,
      };
    }

    try {
      db.transaction((tx) => {
        tx.update(cameraTrapModels)
          .set({ active: false })
          .where(
            and(
              eq(cameraTrapModels.active, true),
              ne(cameraTrapModels.id, modelId),
            ),
          )
          .run();
        tx.update(cameraTrapModels)
          .set({ active: true })
          .where(eq(cameraTrapModels.id, modelId))
          .run();
      });
    } catch (err) {
      // Partial unique index `WHERE active = 1` can throw SQLITE_CONSTRAINT_UNIQUE
      // if two admins activate concurrently and our deactivate-first didn't win.
      if (isUniqueConstraint(err)) {
        return {
          success: false,
          error:
            "Otro administrador acaba de activar un modelo. Refrescá la página.",
        };
      }
      throw err;
    }

    // Tear down the running model server so the next job re-spawns with the
    // new env vars (CUSTOM_CLASSIFIER_WEIGHTS etc.).
    try {
      shutdownModelServer();
    } catch (err) {
      log.warn({ err }, "[ct-models] shutdownModelServer failed");
    }

    await recordEvent({
      source: "camera-trap",
      eventType: "ct_model.activate",
      summary: `Modelo CT activado · ${target[0].version}`,
      severity: "success",
      actorEmail: user.email,
      projectId: "camera-trap",
      targetType: "camera_trap_model",
      targetId: modelId,
      details: { version: target[0].version },
    });

    return { success: true, data: { modelId } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, "[ct-models] activate failed");
    return { success: false, error: msg };
  }
}

function isUniqueConstraint(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  if (e.code === "SQLITE_CONSTRAINT_UNIQUE") return true;
  return (
    typeof e.message === "string" &&
    /SQLITE_CONSTRAINT.*UNIQUE/i.test(e.message)
  );
}

/**
 * Delete a registered model row. Refuses to delete the active model.
 * Does NOT delete files on disk — that's a manual rm by the admin.
 *
 * CASCADE on camera_trap_model_class_metrics.model_id cleans up derived rows
 * silently — we count them up front and log to the audit trail.
 */
export async function deleteModel(
  formData: FormData,
): Promise<ActionResult<{ modelId: number }>> {
  const user = await requireAdmin();

  const modelIdRaw = formData.get("modelId");
  const modelId =
    typeof modelIdRaw === "string" ? Number.parseInt(modelIdRaw, 10) : NaN;
  if (!Number.isFinite(modelId)) {
    return { success: false, error: "modelId is required" };
  }

  try {
    const target = await db
      .select()
      .from(cameraTrapModels)
      .where(eq(cameraTrapModels.id, modelId))
      .limit(1);
    if (target.length === 0) {
      return { success: false, error: `model ${modelId} not found` };
    }
    if (target[0].active) {
      return {
        success: false,
        error: "no se puede borrar el modelo activo. Activá otro primero.",
      };
    }

    const classMetricCountRow = await db
      .select({ n: sql<number>`COUNT(*)` })
      .from(cameraTrapModelClassMetrics)
      .where(eq(cameraTrapModelClassMetrics.modelId, modelId))
      .get();
    const classMetricRowsDeleted = classMetricCountRow?.n ?? 0;

    await db.delete(cameraTrapModels).where(eq(cameraTrapModels.id, modelId));

    await recordEvent({
      source: "camera-trap",
      eventType: "ct_model.delete",
      summary: `Modelo CT eliminado · ${target[0].version}`,
      severity: "warn",
      actorEmail: user.email,
      projectId: "camera-trap",
      targetType: "camera_trap_model",
      targetId: modelId,
      details: {
        version: target[0].version,
        classMetricRowsDeleted,
      },
    });

    return { success: true, data: { modelId } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, "[ct-models] delete failed");
    return { success: false, error: msg };
  }
}

/**
 * Lazy-load the confusion matrix for a model. Called from the drill-down
 * row in the comparison table so the initial page payload stays small.
 */
export async function getConfusionMatrix(
  modelId: number,
): Promise<ActionResult<ParsedConfusionMatrix | null>> {
  await requireAdmin();

  if (!Number.isFinite(modelId)) {
    return { success: false, error: "modelId is required" };
  }

  const row = await db
    .select({ confusionMatrixJson: cameraTrapModels.confusionMatrixJson })
    .from(cameraTrapModels)
    .where(eq(cameraTrapModels.id, modelId))
    .limit(1);
  if (row.length === 0) {
    return { success: false, error: `model ${modelId} not found` };
  }
  const raw = row[0].confusionMatrixJson;
  if (!raw) return { success: true, data: null };

  try {
    const parsed = JSON.parse(raw) as ParsedConfusionMatrix;
    return { success: true, data: parsed };
  } catch (err) {
    log.error({ err, modelId }, "[ct-models] confusion matrix parse failed");
    return { success: false, error: "matriz de confusión malformada" };
  }
}

/**
 * Resolve what the next ML run will actually use for inference: the
 * hard-coded detector + either the active custom classifier (if any) or
 * the legacy AI4G fallback.
 */
export type ActiveClassifierInfo = {
  detector: string;
  classifier:
    | {
        kind: "custom";
        version: string;
        backbone: string;
        top1Accuracy: number | null;
        modelDir: string;
      }
    | { kind: "legacy"; name: string };
};

export async function getActiveClassifierInfo(): Promise<ActiveClassifierInfo> {
  await requirePermission("camera-trap", "viewer");

  const [active] = await db
    .select({
      version: cameraTrapModels.version,
      modelDir: cameraTrapModels.modelDir,
      metricsJson: cameraTrapModels.metricsJson,
    })
    .from(cameraTrapModels)
    .where(eq(cameraTrapModels.active, true))
    .limit(1);

  if (!active) {
    return {
      detector: ML_DEFAULTS.detectorModel,
      classifier: { kind: "legacy", name: ML_DEFAULTS.classifierModel },
    };
  }

  let backbone = "unknown";
  let top1: number | null = null;
  try {
    const m = JSON.parse(active.metricsJson) as {
      backbone?: unknown;
      overall?: { top1Accuracy?: unknown };
    };
    if (typeof m.backbone === "string") backbone = m.backbone;
    if (typeof m.overall?.top1Accuracy === "number") {
      top1 = m.overall.top1Accuracy;
    }
  } catch {
    // metrics is opaque on parse error; backbone stays "unknown"
  }

  return {
    detector: ML_DEFAULTS.detectorModel,
    classifier: {
      kind: "custom",
      version: active.version,
      backbone,
      top1Accuracy: top1,
      modelDir: active.modelDir,
    },
  };
}
