"use server";

/**
 * Camera trap custom-classifier model registry.
 *
 * Models are not uploaded through the portal — an admin SCPs a directory
 * into data/models/<version>/ containing weights.pt, metrics.json, and
 * class_mapping.json, then clicks Register here.
 *
 * Validation rules at registration time are deliberately strict — silent
 * class drift between training and inference is catastrophic, so we
 * hard-fail on any contract mismatch unless the admin explicitly checks
 * "allow untracked dataset".
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { eq, and, ne, inArray } from "drizzle-orm";

import { db } from "@/db";
import {
  cameraTrapModels,
  cameraTrapTrainingDatasets,
  processingJobs,
  activityLog,
  type CameraTrapModel,
} from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import type { ActionResult } from "@/lib/types";
import { shutdownModelServer } from "@/lib/ml-runner";

const MODELS_ROOT = path.join(process.cwd(), "data", "models");

export interface UnregisteredModelDir {
  dirName: string;
  hasWeights: boolean;
  hasMetrics: boolean;
  hasClassMapping: boolean;
}

interface ParsedMetrics {
  modelVersion: string;
  trainingDatasetVersion: string;
  trainingDatasetContentHash: string;
  backbone: string;
  transform: {
    imageSize: number;
    mean: number[];
    std: number[];
  };
  recommendedConfidenceThreshold: number;
  overall: { top1Accuracy: number; macroF1: number };
  perClass: Record<
    string,
    { precision: number; recall: number; f1: number; support: number }
  >;
  classListOrdered: string[];
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
 * Register a model directory. Validates the metrics.json contract,
 * cross-checks class_mapping ↔ classListOrdered, and (unless overridden)
 * verifies the training dataset hash exists in the registry.
 */
export async function registerModelFromDir(
  formData: FormData,
): Promise<ActionResult<{ modelId: number; version: string }>> {
  const user = await requireAdmin();

  const dirName = formData.get("dirName");
  const allowUntracked = formData.get("allowUntracked") === "on";
  if (typeof dirName !== "string" || dirName.length === 0) {
    return { success: false, error: "dirName is required" };
  }
  // Belt-and-suspenders against path traversal — only allow plain dir names.
  if (dirName.includes("/") || dirName.includes("..")) {
    return { success: false, error: "dirName must be a plain directory name" };
  }

  const modelDir = path.join(MODELS_ROOT, dirName);
  const weightsPath = path.join(modelDir, "weights.pt");
  const metricsPath = path.join(modelDir, "metrics.json");
  const classMappingPath = path.join(modelDir, "class_mapping.json");

  try {
    // 1. weights.pt exists and is non-empty.
    let weightsStat;
    try {
      weightsStat = await fs.stat(weightsPath);
    } catch {
      return { success: false, error: `weights.pt not found at ${weightsPath}` };
    }
    if (weightsStat.size === 0) {
      return { success: false, error: "weights.pt is empty" };
    }

    // 2. Parse metrics.json + class_mapping.json.
    let metricsRaw: string;
    try {
      metricsRaw = await fs.readFile(metricsPath, "utf-8");
    } catch {
      return { success: false, error: `metrics.json not found at ${metricsPath}` };
    }
    let metrics: ParsedMetrics;
    try {
      metrics = JSON.parse(metricsRaw) as ParsedMetrics;
    } catch (err) {
      return {
        success: false,
        error: `metrics.json is not valid JSON: ${(err as Error).message}`,
      };
    }

    let classMappingRaw: string;
    try {
      classMappingRaw = await fs.readFile(classMappingPath, "utf-8");
    } catch {
      return {
        success: false,
        error: `class_mapping.json not found at ${classMappingPath}`,
      };
    }
    let classMapping: string[];
    try {
      classMapping = JSON.parse(classMappingRaw) as string[];
    } catch (err) {
      return {
        success: false,
        error: `class_mapping.json is not valid JSON: ${(err as Error).message}`,
      };
    }

    // 3. Required fields.
    const contractError = validateMetricsContract(metrics);
    if (contractError) {
      return { success: false, error: `metrics.json: ${contractError}` };
    }

    // 4. class_mapping ↔ classListOrdered byte-for-byte alignment.
    if (!Array.isArray(classMapping)) {
      return { success: false, error: "class_mapping.json must be a JSON array" };
    }
    if (classMapping.length !== metrics.classListOrdered.length) {
      return {
        success: false,
        error: `class mismatch: class_mapping.json has ${classMapping.length} entries, metrics.classListOrdered has ${metrics.classListOrdered.length}`,
      };
    }
    for (let i = 0; i < classMapping.length; i++) {
      if (classMapping[i] !== metrics.classListOrdered[i]) {
        return {
          success: false,
          error: `class mismatch at index ${i}: class_mapping.json="${classMapping[i]}" vs metrics.classListOrdered="${metrics.classListOrdered[i]}"`,
        };
      }
    }

    // 5. Unique modelVersion.
    const existingVersion = await db
      .select({ id: cameraTrapModels.id })
      .from(cameraTrapModels)
      .where(eq(cameraTrapModels.version, metrics.modelVersion))
      .limit(1);
    if (existingVersion.length > 0) {
      return {
        success: false,
        error: `a model with version "${metrics.modelVersion}" is already registered`,
      };
    }

    // 6. Training dataset hash provenance (unless overridden).
    let trainingDatasetId: number | null = null;
    const expectedHash = metrics.trainingDatasetContentHash.replace(
      /^sha256:/,
      "",
    );
    const datasetMatch = await db
      .select({ id: cameraTrapTrainingDatasets.id })
      .from(cameraTrapTrainingDatasets)
      .where(eq(cameraTrapTrainingDatasets.contentHash, expectedHash))
      .limit(1);
    if (datasetMatch.length > 0) {
      trainingDatasetId = datasetMatch[0].id;
    } else if (!allowUntracked) {
      return {
        success: false,
        error: `trainingDatasetContentHash "${expectedHash}" does not match any registered training dataset. Marca "permitir dataset no registrado" para registrarlo de todos modos.`,
      };
    }

    // 7. Insert.
    const inserted = db.transaction((tx) => {
      return tx
        .insert(cameraTrapModels)
        .values({
          version: metrics.modelVersion,
          modelDir,
          classMappingJson: classMappingRaw,
          metricsJson: metricsRaw,
          confidenceThreshold: metrics.recommendedConfidenceThreshold,
          trainingDatasetId,
          active: false,
          createdBy: user.email,
        })
        .returning()
        .get() as CameraTrapModel;
    });

    await db.insert(activityLog).values({
      userEmail: user.email,
      action: "ct_model.register",
      targetType: "camera_trap_model",
      targetId: String(inserted.id),
      details: JSON.stringify({
        version: inserted.version,
        modelDir,
        trainingDatasetId,
        allowUntracked,
      }),
    });

    return {
      success: true,
      data: { modelId: inserted.id, version: inserted.version },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[ct-models] register failed:", err);
    return { success: false, error: msg };
  }
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

    // Tear down the running model server so the next job re-spawns with the
    // new env vars (CUSTOM_CLASSIFIER_WEIGHTS etc.).
    try {
      shutdownModelServer();
    } catch (err) {
      console.warn("[ct-models] shutdownModelServer failed:", err);
    }

    await db.insert(activityLog).values({
      userEmail: user.email,
      action: "ct_model.activate",
      targetType: "camera_trap_model",
      targetId: String(modelId),
      details: JSON.stringify({ version: target[0].version }),
    });

    return { success: true, data: { modelId } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[ct-models] activate failed:", err);
    return { success: false, error: msg };
  }
}

/**
 * Delete a registered model row. Refuses to delete the active model.
 * Does NOT delete files on disk — that's a manual rm by the admin.
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

    await db.delete(cameraTrapModels).where(eq(cameraTrapModels.id, modelId));

    await db.insert(activityLog).values({
      userEmail: user.email,
      action: "ct_model.delete",
      targetType: "camera_trap_model",
      targetId: String(modelId),
      details: JSON.stringify({ version: target[0].version }),
    });

    return { success: true, data: { modelId } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[ct-models] delete failed:", err);
    return { success: false, error: msg };
  }
}

function validateMetricsContract(m: ParsedMetrics): string | null {
  if (!m || typeof m !== "object") return "must be an object";
  if (typeof m.modelVersion !== "string" || m.modelVersion.length === 0)
    return "modelVersion missing";
  if (typeof m.trainingDatasetVersion !== "string")
    return "trainingDatasetVersion missing";
  if (typeof m.trainingDatasetContentHash !== "string")
    return "trainingDatasetContentHash missing";
  if (typeof m.backbone !== "string") return "backbone missing";
  if (!m.transform || typeof m.transform !== "object")
    return "transform missing";
  if (typeof m.transform.imageSize !== "number")
    return "transform.imageSize missing";
  if (
    !Array.isArray(m.transform.mean) ||
    m.transform.mean.length !== 3 ||
    !m.transform.mean.every((n) => typeof n === "number")
  )
    return "transform.mean must be a 3-element number array";
  if (
    !Array.isArray(m.transform.std) ||
    m.transform.std.length !== 3 ||
    !m.transform.std.every((n) => typeof n === "number")
  )
    return "transform.std must be a 3-element number array";
  if (
    typeof m.recommendedConfidenceThreshold !== "number" ||
    m.recommendedConfidenceThreshold < 0 ||
    m.recommendedConfidenceThreshold > 1
  )
    return "recommendedConfidenceThreshold must be in [0, 1]";
  if (!m.overall || typeof m.overall.top1Accuracy !== "number")
    return "overall.top1Accuracy missing";
  if (typeof m.overall.macroF1 !== "number") return "overall.macroF1 missing";
  if (
    !Array.isArray(m.classListOrdered) ||
    !m.classListOrdered.every((s) => typeof s === "string")
  )
    return "classListOrdered must be a string array";
  return null;
}
