"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { useActiveJobs } from "@/hooks/use-active-jobs";

interface QueueOverviewProps {
  currentJobId: number;
}

export function QueueOverview({ currentJobId }: QueueOverviewProps) {
  const {
    allJobs,
    processingJob,
    pendingJobs,
    totalQueueSize,
    currentQueuePosition,
    hasQueue,
  } = useActiveJobs();

  if (!hasQueue) return null;

  // Aggregate progress across all jobs
  const totalImages = allJobs.reduce((sum, j) => sum + j.totalImages, 0);
  const processedImages = allJobs.reduce((sum, j) => sum + j.processedImages, 0);
  const aggregatePercentage =
    totalImages > 0 ? Math.round((processedImages / totalImages) * 100) : 0;

  return (
    <div className="mb-6 rounded-lg border bg-card p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold">Cola de Procesamiento</h2>
        <span className="text-xs font-medium bg-primary/10 text-primary px-2 py-0.5 rounded-full">
          Trabajo {currentQueuePosition} de {totalQueueSize}
        </span>
      </div>

      {/* Aggregate progress bar */}
      <div className="mb-3">
        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary transition-all duration-300 rounded-full"
            style={{ width: `${aggregatePercentage}%` }}
          />
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          {processedImages} de {totalImages} imágenes totales · {aggregatePercentage}%
        </p>
      </div>

      {/* Job list */}
      <div className="space-y-1">
        {allJobs.map((job) => {
          const isProcessing = job.status === "processing";
          const isCurrent = job.jobId === currentJobId;
          const jobProgress =
            job.totalImages > 0
              ? Math.round((job.processedImages / job.totalImages) * 100)
              : 0;

          return (
            <Link
              key={job.jobId}
              href={`/camera-trap/process?jobId=${job.jobId}`}
              className={cn(
                "flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors",
                isCurrent
                  ? "bg-primary/5 border border-primary/20"
                  : "hover:bg-accent"
              )}
            >
              {/* Status dot */}
              <span
                className={cn(
                  "w-2 h-2 rounded-full shrink-0",
                  isProcessing
                    ? "bg-blue-500 animate-pulse"
                    : "bg-muted-foreground/30"
                )}
              />

              {/* Deployment name */}
              <span className="flex-1 truncate text-sm">
                {job.deploymentName}
              </span>

              {/* Status / count */}
              <span className="text-xs text-muted-foreground shrink-0">
                {isProcessing
                  ? `${jobProgress}%`
                  : `${job.totalImages} img`}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
