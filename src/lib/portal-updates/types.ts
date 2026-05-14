import type { JobType } from "@/lib/job-types";

export type LeaderboardRow = { actorEmail: string; count: number };

export type JobBucket = {
  jobType: JobType;
  label: string;
  completed: number;
  failed: number;
};

export type ProjectActivity = {
  projectId: string;
  projectName: string;
  ctJobs: JobBucket[];
  audioJobs: JobBucket[];
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
