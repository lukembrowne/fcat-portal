/**
 * Centralised job-type discriminator values for the `processingJobs` table.
 *
 * `processingJobs.jobType` is a free-text column (no enum constraint at the
 * DB layer), so module code is responsible for using these constants instead
 * of bare strings. New job types must be added here first, then referenced
 * by their constant name throughout the codebase.
 */

export const JOB_TYPES = {
  ML: "ml",
  ML_INCREMENTAL: "ml_incremental",
  BIRDNET: "birdnet",
  ACOUSTIC_INDICES: "acoustic_indices",
  AUDIO_ANALYSIS: "audio_analysis",
  DRIVE_SYNC: "drive_sync",
  AUDIO_SYNC: "audio_sync",
  COMPRESSION: "compression",
  REVERT_COMPRESSION: "revert_compression",
  AUDIO_COMPRESSION: "audio_compression",
  REVERT_AUDIO_COMPRESSION: "revert_audio_compression",
  SHARED_DRIVES_RECONCILE: "shared_drives_reconcile",
  CACHE_DEPLOYMENT_IMAGES: "cache_deployment_images",
  TRAINING_EXPORT: "training_export",
  TRAINING_EXPORT_UPLOAD: "training_export_upload",
  EXTERNAL_IMPORT: "external_import",
  OCCUPANCY_MODEL: "occupancy_model",
  BIRDNET_THRESHOLD_FIT: "birdnet_threshold_fit",
} as const;

export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];
