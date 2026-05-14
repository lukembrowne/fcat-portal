---
title: Job Lifecycle System Events + Instrumentation Policy
type: feat
date: 2026-05-14
---

# feat: Job Lifecycle System Events + Instrumentation Policy

## Overview

Wire every background-job terminal transition (`completed` / `failed` / `cancelled`) to a single `system_events` row so `/admin/activity` becomes a true "what ran today" audit page. Add a `CLAUDE.md` instrumentation rule so future features don't drift back into the same gap.

Phase 2 of the 2026-05-13 unified system activity log. Phase 1 explicitly deferred job lifecycle ("if a real need emerges, revisit") — Luke ran CT + BirdNET analyses, saw nothing on `/admin/activity`, and that's the need.

**Inputs:**
- Brainstorm: `docs/brainstorms/2026-05-14-job-lifecycle-events-and-instrumentation-policy-brainstorm.md`
- Phase 1 plan: `docs/plans/2026-05-13-feat-unified-system-activity-log-plan.md`
- Multi-reviewer feedback (DHH-style, Kieran-style, Simplicity) — incorporated below

## Problem Statement

10 background-job types (`src/lib/job-types.ts`) write their own status updates to `processing_jobs` but never call `recordEvent()`. The activity page goes silent during exactly the operations a portal admin most wants to audit. The brainstorm settled "one event per job at terminal transition"; this plan settles the *how*.

## Proposed Solution

Extract a single pure payload-builder helper, then call it at every terminal-transition site. Three changes from the brainstorm's first draft, all in response to review:

1. **One helper, not 25 hand-rolled call sites.** `buildJobCompletionEvent(job, extras?)` in `src/lib/system-events.ts` encodes the severity map, source map, eventType template, durationMs, projectId, and summary format. The brainstorm's rejection of "a central wrapper" was specifically about state-machine wrappers around DB transitions — this is a pure function on a row that's already been written. Conceptual compression, not abstraction.
2. **Distinct event types per outcome**: `<source>_<jobType>.completed` / `.failed` / `.cancelled`. Severity is redundant-but-honest. `.complete` for a `cancelled` job read wrong, per all three reviewers.
3. **Local idempotency in `processJobInternal`** (and `processFlacCompressionJob`) via a per-invocation `eventEmitted` flag, so the success-update-then-catch-block-update double-emit window is structurally closed, not just unit-tested.

## Helper Specification

```ts
// src/lib/system-events.ts (additions)

import { JOB_TYPES, type JobType } from "@/lib/job-types";
import type { ProcessingJob, EventSource, EventSeverity } from "@/db/schema";

export type JobCompletionExtras = Record<string, unknown>;

const AUDIO_JOB_TYPES = new Set<JobType>([
  JOB_TYPES.BIRDNET,
  JOB_TYPES.ACOUSTIC_INDICES,
  JOB_TYPES.AUDIO_ANALYSIS,
  JOB_TYPES.AUDIO_SYNC,
  JOB_TYPES.AUDIO_COMPRESSION,
  JOB_TYPES.REVERT_AUDIO_COMPRESSION,
]);

const JOB_LABELS: Record<JobType, string> = {
  ml: "ML",
  ml_incremental: "ML incremental",
  drive_sync: "Sincronización Drive",
  compression: "Compresión de imágenes",
  revert_compression: "Reversión de compresión",
  birdnet: "BirdNET",
  acoustic_indices: "Índices acústicos",
  audio_analysis: "Análisis de audio",
  audio_sync: "Sincronización de audio",
  audio_compression: "Compresión FLAC",
  revert_audio_compression: "Reversión de compresión FLAC",
};

const OUTCOME_VERBS = {
  completed: "completado",
  failed: "fallido",
  cancelled: "cancelado",
} as const;

export function buildJobCompletionEvent(
  job: ProcessingJob,
  extras?: JobCompletionExtras,
): RecordEventInput {
  const outcome =
    job.status === "completed" ? "completed" :
    job.status === "failed"    ? "failed"    : "cancelled";
  const source: EventSource =
    AUDIO_JOB_TYPES.has(job.jobType as JobType) ? "audio" : "camera-trap";
  const severity: EventSeverity =
    outcome === "completed" ? "success" :
    outcome === "failed"    ? "error"   : "warn";
  const durationMs = job.startedAt ? Date.now() - job.startedAt.getTime() : null;
  const projectId = job.cameraTrapProjectId
    ? `camera-trap:${job.cameraTrapProjectId}`
    : source === "audio" ? "grabaciones" : "camera-trap";
  const scope = job.deploymentId
    ? `Instalación ${job.deploymentId}`
    : job.cameraTrapProjectId
      ? `Proyecto ${job.cameraTrapProjectId}`
      : "Todos los proyectos";

  return {
    source,
    eventType: `${source}_${job.jobType}.${outcome}`,
    severity,
    summary: `${JOB_LABELS[job.jobType as JobType] ?? job.jobType} ${OUTCOME_VERBS[outcome]} · ${scope}`,
    actorEmail: job.createdBy ?? null,
    projectId,
    targetType: "processing_job",
    targetId: job.id,
    durationMs,
    details: {
      ...(job.errorMessage ? { errorMessage: job.errorMessage } : {}),
      ...(extras ?? {}),
    },
  };
}
```

**Details JSON is deliberately minimal** (per Simplicity review). Consumers join `processing_jobs` on `targetId` for `processed`/`total`/`failedImages`/`detectorModel`/etc. Only `errorMessage` is denormalized (UI convenience), plus per-job aggregates passed via `extras` that aren't on the row — e.g., BirdNET `speciesCount` / `totalDetections`.

## Double-Emit Mitigation

`processJobInternal` (camera-trap ML) has a success path at line 824 followed by code that could throw (`safeRevalidate`, `processNextInQueue`, re-fetch), funneling into the catch at line 858 which writes `status: "failed"` again at 872. Without protection, both branches emit. Same shape exists in `processFlacCompressionJob` in `audio-compression-core.ts`.

Mitigation pattern (local to each multi-path processor — not a global wrapper):

```ts
async function processJobInternal(jobId: number) {
  let eventEmitted = false;
  const emitTerminalEvent = async (extras?: JobCompletionExtras) => {
    if (eventEmitted) return;
    eventEmitted = true;
    const [j] = await db.select().from(processingJobs).where(eq(processingJobs.id, jobId));
    if (j) await recordEvent(buildJobCompletionEvent(j, extras));
  };
  // ...after each terminal db.update(...) inside the function body:
  //   await emitTerminalEvent();  // idempotent
}
```

For single-path processors (BirdNET, acoustic indices, audio_analysis) the flag is unnecessary — three linear branches (`completed` / `failed` / `cancelled`), one emission each.

## Site Inventory (28 sites, 10 job types)

The brainstorm estimated "~12." Exhaustive grep verified 28 — the original count missed the four CT-compression failed-path catch blocks that currently emit nothing (now in scope), plus the `drive-sync-worker-core.ts:320` outer-catch site that's distinct from `finalize()`.

### Camera Trap ML (`ml`, `ml_incremental`) — `src/app/camera-trap/actions.ts`

| # | Line | Status | Notes |
|---|------|--------|-------|
| 1 | ~406 | `failed` | Pre-flight: no Drive files downloaded |
| 2 | 717 | `completed` | Empty deployment edge case |
| 3 | 755 | `failed` | ML server unavailable |
| 4 | 824 | dynamic via `finalStatus` | Primary success/failure path |
| 5 | 872 | `failed` | Catch-block — double-emit window with #4 |
| 6 | 1000 | `cancelled` | `cancelJob()` per-job |
| 7 | 2911 | `cancelled` | Bulk cancel queue — emit once per cancelled jobId |

Uses the local `emitTerminalEvent` flag pattern (above) to close the #4 ↔ #5 window.

### CT Drive Sync (`drive_sync`) + Audio Drive Sync (`audio_sync`) — `src/lib/drive-sync-worker-core.ts`

| # | Line | Status | Notes |
|---|------|--------|-------|
| 8 | ~143 | dynamic (3 values) | Add `recordEvent` inside `finalize()` — instruments both job types from one site |
| 9 | 320 | `failed` | Outer-catch terminal write after finalize might already have fired. Reuse the `emitTerminalEvent` flag pattern inside `runDriveSync` |

### CT Compression / Revert (`compression`, `revert_compression`) — `src/app/camera-trap/drive-actions.ts`

**Collision decision (per Kieran review):** Lines 636 and 910 already call `recordEvent` with `eventType: "compress_images"` / `"revert_compression"`, `targetType: "deployment"`. These fire on success only — the failed-path catch blocks (665, 932) emit nothing today. **Replace** the existing events at 636/910 with lifecycle events via the helper, and add matching emissions in the failed paths. One job ↔ one event; the helper's `targetType: "processing_job"` is more precise than the existing deployment-scoped event, and `eventType` is now lifecycle-shaped.

| # | Line | Status | Action |
|---|------|--------|--------|
| 10 | 628→636 | `completed` | Replace existing `compress_images` event |
| 11 | 665 | `failed` | Add (no event today) |
| 12 | 902→910 | `completed` | Replace existing `revert_compression` event |
| 13 | 932 | `failed` | Add (no event today) |

### Audio BirdNET (`birdnet`) — `src/app/audio/actions.ts`

| # | Line | Status |
|---|------|--------|
| 14 | 627 | `completed` |
| 15 | 653 | `failed` |
| 16 | 704 | `cancelled` |

### Audio Acoustic Indices (`acoustic_indices`) — `src/app/audio/actions.ts`

| # | Line | Status |
|---|------|--------|
| 17 | 1004 | `completed` |
| 18 | 1036 | `failed` |
| 19 | 1075 | `cancelled` (in `cancelAcousticIndicesJob`) |

### Audio Analysis (`audio_analysis`) — `src/app/audio/actions.ts`

| # | Line | Status | Notes |
|---|------|--------|-------|
| 20 | 1295 | `cancelled` | Mid-compression-phase cancel |
| 21 | 1622 | `completed` | Primary completion |
| 22 | 1651 | `failed` | Catch block |
| 23 | 1691 | `cancelled` | `cancelAudioAnalysisJob` |

`audio_analysis` is a meta-job wrapping compression + birdnet + indices phases (no separate `processing_jobs` rows for the embedded phases). One event when the wrapper terminates — do not double-emit for the embedded compression phase. The pre-existing `activityLog.insert` at line 1271 writes to the legacy `activity_log` table — leave it alone (different table, different purpose).

### Audio Compression / Revert — `src/lib/audio-compression-core.ts`

`audio_compression` + `revert_audio_compression`. Both run inside `processFlacCompressionJob` / `processRevertCompressionJob`, which have multi-phase success paths — use the local `emitTerminalEvent` flag pattern here too.

| # | Line | Status |
|---|------|--------|
| 24 | 261 | `cancelled` |
| 25 | 789 | `completed` |
| 26 | 837 | `failed` |
| 27 | 1045 | `completed` (revert) |
| 28 | 1072 | `failed` (revert) |

**`createdBy` for script-driven jobs**: `scripts/compress-all-audio.mjs` must set `createdBy: "system:compress-all-audio"` (defaults to the script's name, not null). One-line fix in the script's job-insert call.

### Sites explicitly NOT instrumented

- `src/lib/ml-runner.ts:501` — per-image failure, not a job-level transition.
- Any `db.update(...).set({ statusMessage: ... })` without a status change. Ticks, not transitions.
- `status: "processing"` / `"pending"` writes. Non-terminal.

## Implementation Phases

Two phases (was five — collapsed per Simplicity review; no real dependencies between the original 2–5).

### Phase 1: Helper + canonical site + tests + CLAUDE.md

- Add `buildJobCompletionEvent()` to `src/lib/system-events.ts` (spec above).
- Instrument BirdNET (sites 14–16) as the first concrete consumer.
- Unit tests:
  - **Helper contract**: for each `JobType`, given a mock `ProcessingJob` with each terminal `status`, `buildJobCompletionEvent` returns the expected `RecordEventInput` (source, eventType, severity, projectId, summary, durationMs). One parameterized test.
  - **Coverage guard**: load `JOB_TYPES`, assert each value appears at least once in the helper's source mapping. Catches "added a new job type, forgot to update the helper."
  - **Idempotency**: `emitTerminalEvent` called twice in sequence writes exactly one row.
- Update `CLAUDE.md` (wording below).
- One PR.

### Phase 2: Instrument all remaining sites

Sites 1–13, 17–28 in one PR. Each site is one helper call + (for multi-path processors) the local flag pattern. Mechanical.

Add one end-to-end smoke test that exercises a real BirdNET job against the test DB and asserts the `system_events` row lands. Other processors covered by the helper contract test — no per-processor matrix needed.

## CLAUDE.md Addition

Add under "Conventions":

> **System events instrumentation.** Any server action, background job, cron, or admin-facing mutation should consider calling `recordEvent()` (from `@/lib/system-events`). Default **yes** for: terminal transitions on `processing_jobs` (use `buildJobCompletionEvent(job)`), destructive user actions, admin/permission changes, bulk data uploads, cron job completions, external sync runs. Default **no** for: high-frequency per-row reads/writes (verification clicks, autosaves, status-message ticks) — emit one event at the end of the batch/loop instead. New job types must extend `JOB_LABELS` and `AUDIO_JOB_TYPES` (if applicable) in `src/lib/system-events.ts`.

## Acceptance Criteria

- [x] `buildJobCompletionEvent()` exists in `src/lib/system-events.ts` matching the spec above. *(Phase 1)*
- [x] All 28 sites in the inventory call `recordEvent(buildJobCompletionEvent(job, extras?))` after the terminal `db.update(processingJobs).set({ status: ... })`. *(Phase 2 finished the remaining 25 sites.)*
- [x] Multi-path processors (`processJobInternal`, `processFlacCompressionJob`, `processAudioRevertJob`, `runDriveSyncWorkerGeneric`, `processAudioAnalysisJob`) use the local `emitTerminalEvent` flag pattern. *(Phase 2)*
- [x] Existing `compress_images` / `revert_compression` events in `drive-actions.ts:636, 910` are removed (replaced by lifecycle events via the helper). *(Phase 2)*
- [x] `scripts/compress-all-audio.mjs` populates `createdBy` (already routed through the required `ACTOR_EMAIL` env var into `enqueueAudioCompressionJob` → `createdBy: actorEmail`; no code change needed). *(Phase 2)*
- [x] Helper-contract unit test passes for every `JobType` × every terminal status. *(Phase 1)*
- [x] Coverage-guard unit test asserts every `JobType` is recognized by the helper's source mapping. *(Phase 1 — added `ML_INCREMENTAL` to `JOB_TYPES` to close a pre-existing gap.)*
- [x] End-to-end smoke test: BirdNET success/failed/cancelled round-trip produces `system_events` rows with the expected `source`, `eventType`, `severity`, `targetType`. *(Phase 2 — parameterized test added)*
- [x] `CLAUDE.md` has the new "System events instrumentation" bullet. *(Phase 1)*
- [ ] Manual verification: run an ML analysis, a BirdNET analysis, and an audio compression job from the UI; all three appear on `/admin/activity` with correct severity, summary, and `targetId`. *(Awaiting deploy + manual exercise.)*

## Implementation Notes (not blocking; resolve in PR)

- **Per-image failure severity.** If a job completes with `failedImages > 0`, severity stays `success`; `details.errorMessage` is null but `processing_jobs.failedImages` carries the count. Revisit if partial failures need visual prominence on the activity page.
- **`projectId` granularity.** Spec puts `camera-trap:<id>` when `cameraTrapProjectId` is set, otherwise the source-fixed string. If `system_events.projectId` needs to support the standard project filter UI, may need to normalize.
- **Watchdog/stuck-job recovery.** Grep audit (`isJobStillActive`, `stuckJob`, startup hooks) found no separate cron/startup path that marks jobs failed — `isJobStillActive` is a check, not a writer. If one is added later, instrument it then.

## Risks

- **Drift across sites**: mitigated by the helper (one place owns the schema) + the coverage-guard test.
- **better-sqlite3 async-transaction gotcha** (`docs/solutions/runtime-errors/async-transaction-better-sqlite3-CameraTrap-20260223.md`): `recordEvent` is async; do NOT wrap a terminal `db.update` + `recordEvent` in `db.transaction(async ...)`. Keep sequential awaits.
- **Bulk cancel volume** (site #7): cancelling N pending jobs emits N events at once. Expected per brainstorm; pagination on `/admin/activity` already handles it.

## References

- `src/lib/system-events.ts` — `recordEvent()` (existing)
- `src/lib/job-types.ts` — `JOB_TYPES` canonical list
- `src/db/schema.ts:514` — `systemEvents` table, `EVENT_SOURCES`, `EVENT_SEVERITIES`
- `src/app/admin/activity/page.tsx` — consumer
- `tests/unit/system-events.test.ts` — test pattern reference
- In-domain `recordEvent` examples: `src/app/admin/actions.ts:75`, `src/app/finance/data/actions.ts:101`, `src/app/api/cron/nightly-refresh/route.ts:184`
- Async-transaction gotcha: `docs/solutions/runtime-errors/async-transaction-better-sqlite3-CameraTrap-20260223.md`
