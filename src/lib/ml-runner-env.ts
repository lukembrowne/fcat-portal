/**
 * Pure helpers for assembling the env vars passed to the Python model server.
 *
 * Extracted from ml-runner.ts so the assembly logic can be unit-tested
 * without spawning a child process.
 */

import { ML_DEFAULTS } from "@/lib/ml-defaults";

/**
 * The minimum subset of a `camera_trap_models` row needed to assemble env
 * vars. Kept narrow so tests don't need to construct full Drizzle rows.
 */
export interface ActiveModelForEnv {
  id: number;
  modelDir: string;
  classMappingJson: string;
  metricsJson: string;
  /**
   * Version string, used only for display (stamped onto processingJobs.classifierModel
   * at spawn time so the jobs table shows the actually-resolved classifier instead
   * of the AI4G default written at job creation). Optional so existing tests that
   * construct this shape directly don't need to change.
   */
  version?: string;
}

/**
 * Build the classifier-related env vars passed to the Python model server.
 *
 * - When no active model is registered, falls back to AI4G defaults so the
 *   pipeline behaves identically to today.
 * - When an active model exists, parses its metrics.json transform block and
 *   serializes it as a single env var the Python side will load with json.loads.
 *
 * Throws if metrics.json is malformed — that's a load-bearing contract and
 * we'd rather fail to spawn than ship a misconfigured classifier.
 */
export function buildClassifierEnv(
  activeModel: ActiveModelForEnv | null,
): Record<string, string> {
  if (!activeModel) {
    return {
      CLASSIFIER_MODEL: ML_DEFAULTS.classifierModel,
    };
  }

  let metrics: {
    backbone?: unknown;
    transform?: { imageSize?: unknown; mean?: unknown; std?: unknown };
  };
  try {
    metrics = JSON.parse(activeModel.metricsJson);
  } catch (err) {
    throw new Error(
      `active model ${activeModel.id} has invalid metrics.json: ${(err as Error).message}`,
    );
  }
  if (typeof metrics.backbone !== "string") {
    throw new Error(
      `active model ${activeModel.id} metrics.json missing backbone`,
    );
  }
  if (
    !metrics.transform ||
    typeof metrics.transform.imageSize !== "number" ||
    !Array.isArray(metrics.transform.mean) ||
    !Array.isArray(metrics.transform.std)
  ) {
    throw new Error(
      `active model ${activeModel.id} metrics.json missing transform block`,
    );
  }

  // Resolve the standard file layout for a registered model directory.
  // The directory itself is stored in modelDir; weights.pt and class
  // mapping live alongside metrics.json.
  const weightsPath = `${activeModel.modelDir}/weights.pt`;
  const classMappingPath = `${activeModel.modelDir}/class_mapping.json`;

  return {
    CLASSIFIER_MODEL: "custom_timm",
    CUSTOM_CLASSIFIER_WEIGHTS: weightsPath,
    CUSTOM_CLASSIFIER_CLASS_MAPPING: classMappingPath,
    CUSTOM_CLASSIFIER_BACKBONE: metrics.backbone,
    CUSTOM_CLASSIFIER_TRANSFORM_JSON: JSON.stringify({
      imageSize: metrics.transform.imageSize,
      mean: metrics.transform.mean,
      std: metrics.transform.std,
    }),
  };
}
