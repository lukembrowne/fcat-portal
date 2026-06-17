---
date: 2026-06-17
topic: overnight-batch-processing
---

# Overnight Batch Processing of Deployments

## What We're Building

A scheduled nightly batch processor that works through the backlog of unprocessed
deployments during a low-activity window (**10pm–6am**), starting with **audio**
(BirdNET + acoustic indices) and designed to later extend to **camera-trap ML**.
Motivation: ~40 audio deployments are unprocessed and we're falling behind.

The portal already has the hard parts: a unified **single-worker job queue**
(`src/lib/job-queue.ts`, one job at a time portal-wide, self-draining), batch
enqueue primitives (`batchCreateAudioAnalysisJobs` / `batchCreateBirdNETJobs`),
the cron pattern (`verifyCronSecret`, `recordEvent`, single-flight-by-reuse), and
derived "unprocessed" detection (pure SQL, no schema change). What's new is a
**scheduler, a time-window gate, and a "settled uploads" heuristic**.

## Why This Approach

**Chosen: Approach A — Cron enqueues + window-gated dispatcher.** A new
`/api/cron/nightly-audio-batch` route fires at 10pm, selects eligible deployments
(unprocessed + settled, oldest-first), and enqueues them via the existing batch
functions. The single new queue change: `processNextQueueable` gains a window
check so it only *starts* auto-enqueued batch jobs during 10pm–6am.

Rejected **B (standalone scheduler loop)** — duplicates the worker/claim model the
queue already provides; two scheduling systems to maintain (YAGNI). Rejected
**C (dumb enqueue, no gate)** — a large batch would drain into the workday when
uploads resume and CPU contention hurts; doesn't respect the window.

## Key Decisions

- **Eligibility = "settled" via quiet period + lifecycle.** Prefer deployments
  marked retrieved in ODK (`retrieve_sensors` lifecycle) AND require an upload
  quiet period as a safety net: file count stable across refreshes
  (`uploadAudioCount == previousAudioCount`) and `uploadNewestAudioDate` older
  than ~24–48h. This is the only genuinely new logic — no existing
  upload-in-progress signal exists, so it must be inferred from cached Drive
  re-count fields on `biochoco_deployments`.
- **Analysis scope (v1): BirdNET + acoustic indices** (combined `audio_analysis`)
  so deployments come out fully analyzed overnight.
- **Pick order: oldest data first** — clears the longest-waiting backlog,
  matching the "we're behind" framing.
- **Window boundary: let the last job overrun.** Keep dispatching until 6am;
  whatever started runs to completion past 6am (no mid-job cancellation exists).
  The gate lives in the **dispatch decision** (only *start* a queued auto-job
  while inside 10pm–6am), not in blind queue draining.
- **Late files / reprocessing: detect-and-flag + auto-reprocess whole deployment.**
  When a deployment's file count grows after it was processed, flag it in the
  admin UI AND auto-reprocess the entire deployment on a later night (overnight
  compute is effectively free). Avoids building per-file BirdNET tracking now
  (which doesn't exist — a BirdNET job currently deletes prior auto-detections
  and re-runs the whole deployment). Per-file incremental is a future
  optimization. **This policy should be designed to apply to camera-trap images too.**
- **Concurrency: keep the existing global single-worker** (one job at a time).
  No new cap needed; the queue already enforces it.
- **No schema change required** for unprocessed-detection or the queue. May want
  a lightweight "batch-origin" marker on jobs so the window gate only affects
  auto-enqueued jobs, not manual daytime triggers.
- **Instrumentation:** emit `recordEvent` on the nightly batch's terminal
  outcome (`source: "cron"`), Spanish summary, per CLAUDE.md conventions.

## Open Questions

- **Window gate marker:** how to distinguish auto-enqueued batch jobs from manual
  daytime jobs so the 10pm–6am gate only applies to the former (e.g.
  `createdBy: "cron@nightly-audio"` or a dedicated column/job-type)?
- **Throughput reality:** with one job at a time, how many deployments realistically
  clear per 8h night? May need a sense of average BirdNET+indices runtime per
  deployment to set expectations on backlog burn-down.
- **Quiet-period thresholds:** exact values (24h vs 48h; how many stable refreshes).
  Depends on real field upload cadence — `monitoreo@fcat-ecuador.org` uploads.
- **Re-count cadence:** the "settled" heuristic needs periodic Drive re-counts to
  sample deltas. Reuse the existing nightly recount, or add one before the 10pm batch?
- **Camera-trap extension:** confirm the same eligibility + flag-and-reprocess
  model maps cleanly to `biochoco_processing_jobs` ML jobs (likely yes — shared queue).
- **Admin visibility:** what UI surfaces the nightly batch results and the
  "needs reprocessing" flags (audio page banner? activity log? email summary)?

## Next Steps

→ `/workflows:plan` for implementation details
