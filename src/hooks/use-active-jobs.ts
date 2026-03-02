"use client";

import { useEffect, useState, useRef, useCallback } from "react";

export interface ActiveJob {
  jobId: number;
  deploymentId: number;
  deploymentName: string;
  status: string;
  jobType: string;
  totalImages: number;
  processedImages: number;
  statusMessage: string | null;
  startedAt: string | null;
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

  // Derived state
  const processingJob = allJobs.find((j) => j.status === "processing") ?? null;
  const pendingJobs = allJobs.filter((j) => j.status === "pending");
  const totalQueueSize = allJobs.length;
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
    processingJob,
    pendingJobs,
    totalQueueSize,
    currentQueuePosition,
    hasQueue,
    newJobDetected,
  };
}
