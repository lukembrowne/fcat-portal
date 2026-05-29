/**
 * Zod schema for metrics.json (training-pipeline contract v2).
 *
 * Replaces the hand-rolled ParsedMetrics interface + validateMetricsContract.
 * Single source of truth for both the TS type and runtime validation.
 *
 * Contract v2 additions over v1:
 * - `contract.version === "v2"` (required)
 * - `perClass[<class>].trainCount` (required)
 * - `confusion_matrix.csv` is a required sibling artifact (validated separately)
 *
 * Class names are regex-bounded to defend against XSS / export-injection if
 * they're ever rendered into HTML/SVG, exported as CSV (Excel formula), etc.
 * Camera-trap species labels (`Leopardus_tigrinus`, `"Tigrillo oncilla"`) fit.
 */

import { z } from "zod";

const CLASS_NAME_REGEX = /^[A-Za-z0-9_\-. ]{1,128}$/;

const ClassNameSchema = z
  .string()
  .regex(CLASS_NAME_REGEX, {
    message:
      "class name must match /^[A-Za-z0-9_\\-. ]{1,128}$/ (defense-in-depth)",
  });

// sklearn emits NaN when support=0; we accept any number here and the importer
// converts NaN to null at the storage boundary.
const PerClassSchema = z.object({
  precision: z.number(),
  recall: z.number(),
  f1: z.number(),
  support: z.number().int().nonnegative(),
  trainCount: z.number().int().nonnegative(),
});

const TransformSchema = z.object({
  imageSize: z.number().int().positive(),
  mean: z.array(z.number()).length(3),
  std: z.array(z.number()).length(3),
  // Additive (contract v2.1): the full preprocessing recipe so inference can
  // reproduce training byte-for-byte. Optional — models registered before
  // these existed default to bilinear/on/squash in buildClassifierEnv.
  interpolation: z.enum(["bilinear", "bicubic", "nearest"]).optional(),
  antialias: z.boolean().optional(),
  resize: z.literal("squash").optional(),
});

const OverallSchema = z.object({
  top1Accuracy: z.number(),
  macroF1: z.number(),
});

const ContractSchema = z.object({
  version: z.literal("v2"),
  artifacts: z.array(z.string()).optional(),
});

export const MetricsV2Schema = z.object({
  contract: ContractSchema,
  modelVersion: z.string().min(1),
  trainingDatasetVersion: z.string().min(1),
  trainingDatasetContentHash: z.string().min(1),
  backbone: z.string().min(1),
  transform: TransformSchema,
  recommendedConfidenceThreshold: z.number().min(0).max(1),
  overall: OverallSchema,
  perClass: z.record(ClassNameSchema, PerClassSchema),
  classListOrdered: z.array(ClassNameSchema).min(1),
  // training block is opaque to us — we surface its fields in the UI but
  // don't mandate a shape. Stored verbatim inside metricsJson.
  training: z.record(z.string(), z.unknown()).optional(),
});

export type MetricsV2 = z.infer<typeof MetricsV2Schema>;
export type PerClassMetrics = z.infer<typeof PerClassSchema>;

/**
 * Sentinel for the old (v1) contract — used only to recognise legacy models
 * being re-imported and produce the contract-version-unsupported error.
 */
export function looksLikeV1Contract(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const obj = raw as { contract?: unknown; contractVersion?: unknown };
  if (obj.contract && typeof obj.contract === "object") return false;
  return obj.contractVersion === undefined || obj.contractVersion === "v1";
}
