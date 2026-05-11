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
  BIRDNET: "birdnet",
  DRIVE_SYNC: "drive_sync",
  AUDIO_SYNC: "audio_sync",
  COMPRESSION: "compression",
  REVERT_COMPRESSION: "revert_compression",
} as const;

export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];
