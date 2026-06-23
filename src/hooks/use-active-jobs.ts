"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import {
  BATCH_CREATED_BY,
  isWithinEcuadorNightWindow,
} from "@/lib/audio-batch-eligibility";

export interface ActiveJob {
  jobId: number;
  deploymentId: number | null;
  deploymentName: string;
  cameraTrapProjectId: number | null;
  cameraTrapProjectName: string | null;
  displayName: string;
  status: string;
  jobType: string;
  totalImages: number;
  processedImages: number;
  statusMessage: string | null;
  startedAt: string | null;
  createdBy: string | null;
  downloadedImages: number;
  downloadTotal: number;
  cachedImages: number;
  canCancel: boolean;
}

const POLL_INTERVAL = 3000;
const EMPTY_POLLS_BEFORE_STOP = 2;

export function useActiveJobs() {
  const [allJobs, setAllJobs] = useState<ActiveJob[]>([]);
  const [polling, setPolling] = useState(false);

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const emptyPollCountRef = useRef(0);
  const lastJobIdRef = useRef<number | null>(null);
  const [newJobDetected, setNewJobDetected] = useState(0);

  // Window-aware split. Outside the 10pm–6am Ecuador window, the queue picker
  // refuses to *start* nightly-batch rows (createdBy='cron@batch') — they're
  // parked until tonight's 10pm cron resumes them (see job-queue.ts). Treating
  // them as an active queue produces the misleading "Procesando 0 de N" all day,
  // so we pull them out into `scheduledJobs` and let the widget label them as
  // scheduled instead. Recomputed each poll (3s), so the boundary self-corrects.
  const inNightWindow = isWithinEcuadorNightWindow(new Date());
  const isParkedBatch = (j: ActiveJob) =>
    j.status === "pending" && j.createdBy === BATCH_CREATED_BY;

  const scheduledJobs = inNightWindow
    ? []
    : allJobs.filter(isParkedBatch);
  const liveJobs = inNightWindow
    ? allJobs
    : allJobs.filter((j) => !isParkedBatch(j));

  // Derived state (over live jobs only — parked batch rows are excluded above)
  const processingJob = liveJobs.find((j) => j.status === "processing") ?? null;
  const pendingJobs = liveJobs.filter((j) => j.status === "pending");
  const totalQueueSize = liveJobs.length;
  const currentQueuePosition =
    processingJob && totalQueueSize > 1
      ? totalQueueSize - pendingJobs.length
      : 0;
  const hasQueue = totalQueueSize > 1;

  // Start polling (called by job-started event or on mount check)
  const startPolling = useCallback(() => {
    emptyPollCountRef.current = 0;
    setPolling(true);
  }, []);

  // Poll /api/active-jobs for active jobs
  const pollActiveJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/active-jobs");
      if (!res.ok) return;
      const jobs: ActiveJob[] = await res.json();

      setAllJobs(jobs);

      if (jobs.length > 0) {
        emptyPollCountRef.current = 0;

        // Find the currently processing job (or highest ID)
        const current =
          jobs.find((j) => j.status === "processing") ??
          jobs.reduce((a, b) => (a.jobId > b.jobId ? a : b));

        // New job discovered — notify consumers
        if (current.jobId !== lastJobIdRef.current) {
          lastJobIdRef.current = current.jobId;
          setNewJobDetected((n) => n + 1);
        }
      } else {
        emptyPollCountRef.current++;
        if (emptyPollCountRef.current >= EMPTY_POLLS_BEFORE_STOP) {
          setPolling(false);
        }
      }
    } catch {
      // Silently ignore polling errors
    }
  }, []);

  // Listen for job-started (begin polling) and jobs-updated (immediate poll)
  useEffect(() => {
    const handleJobStarted = () => startPolling();
    const handleJobsUpdated = () => pollActiveJobs();
    window.addEventListener("job-started", handleJobStarted);
    window.addEventListener("jobs-updated", handleJobsUpdated);
    return () => {
      window.removeEventListener("job-started", handleJobStarted);
      window.removeEventListener("jobs-updated", handleJobsUpdated);
    };
  }, [startPolling, pollActiveJobs]);

  // One-time check on mount to catch jobs already running (e.g. page refresh)
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/active-jobs");
        if (!res.ok) return;
        const jobs: ActiveJob[] = await res.json();
        if (jobs.length > 0) startPolling();
      } catch {
        // ignore
      }
    })();
  }, [startPolling]);

  // Polling loop — only runs when `polling` is true
  useEffect(() => {
    if (!polling) {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      return;
    }

    const poll = () => {
      pollActiveJobs();
      pollTimerRef.current = setTimeout(poll, POLL_INTERVAL);
    };
    poll();

    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [polling, pollActiveJobs]);

  return {
    allJobs,
    liveJobs,
    scheduledJobs,
    inNightWindow,
    processingJob,
    pendingJobs,
    totalQueueSize,
    currentQueuePosition,
    hasQueue,
    newJobDetected,
  };
}
