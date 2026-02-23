/**
 * MVP defaults for ML processing.
 * Single source of truth — used by ProcessButton and createProcessingJob.
 */
export const ML_DEFAULTS = {
  detectorModel: "MDV6-yolov9-c",
  classifierModel: "AI4GAmazonRainforest",
  confidenceThreshold: 0.1,
  batchSize: 16,
  numWorkers: 2,
} as const;
