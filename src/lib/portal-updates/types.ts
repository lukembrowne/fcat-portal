import type { JobType } from "@/lib/job-types";

export type LeaderboardRow = { actorEmail: string; count: number };

export type JobDetail = {
  jobId: number;
  deploymentName: string;
  siteName: string | null;
  jobType: JobType;
  label: string; // JOB_LABELS[jobType]
  status: "completed" | "failed";
  totalImages: number;
  processedImages: number;
  failedImages: number;
  totalVideos: number;
  extractedFrames: number;
  durationMs: number | null; // completedAt − startedAt (null if startedAt missing)
  detectorModel: string | null;
  classifierModel: string | null;
  errorMessage: string | null;
};

export type ProjectActivity = {
  projectId: string;
  projectName: string;
  ctJobs: JobDetail[];
  audioJobs: JobDetail[];
  ctVerifiedImages: number;
  ctTopVerificadores: LeaderboardRow[];
  audioVerifiedFiles: number;
  audioTopVerificadores: LeaderboardRow[];
};

export type PortalUpdatesPayload = {
  windowStart: Date;
  windowEnd: Date;
  projects: ProjectActivity[];
  totalCtJobs: number;
  totalAudioJobs: number;
  totalCtVerifiedImages: number;
  totalAudioVerifiedFiles: number;
};
