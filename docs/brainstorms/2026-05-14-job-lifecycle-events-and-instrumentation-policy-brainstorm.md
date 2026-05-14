---
date: 2026-05-14
topic: job-lifecycle-events-and-instrumentation-policy
---

# Job Lifecycle Events + Portal-Wide Instrumentation Policy

## What We're Building

Two related changes:

1. **Job lifecycle coverage.** Every background-job type in the portal writes a single `system_events` row when it terminates (completed / failed / cancelled). Backfills the Phase 2 work that the original `/admin/activity` plan (2026-05-13) explicitly deferred. Eight job types in scope: camera-trap ML (`ml`, `ml_incremental`), camera-trap Drive sync (`drive_sync`), camera-trap image compression (`compression`, `revert_compression`), audio BirdNET (`birdnet`), audio acoustic indices (`audio_analysis`), audio Drive sync (`audio_sync`), audio compression (`audio_compression`, `revert_audio_compression`). One event per job, on terminal transition only.

2. **Instrumentation policy in CLAUDE.md.** Add a "when implementing new features, consider whether the operation deserves a `system_events` row" rule so future work doesn't drift back into the same gap.

## Why This Approach

**Why now, not in Phase 1.** The original plan cut job lifecycle on the assumption that the "Trabajos de ML" history page (backed by `processing_jobs`) already covers the question "what ran today." In practice that's only true if you know which page to open and you only care about ML. As the portal grew to 8 job types across two domains (camera-trap + audio), the activity log started feeling broken — running BirdNET and CT analysis and seeing nothing on `/admin/activity` is the failure mode that prompted this brainstorm.

**Why "completion only," not lifecycle.** The user's mental model for `/admin/activity` is "audit trail of everything material." A queued-but-not-yet-run job isn't material on its own — the meaningful moment is the outcome. One row per job keeps storage and noise low while still answering "what ran today" and "what failed today" from the activity page alone.

**Why job-scope first, defer other coverage.** Non-job mutations (finance edits, BioChoco habitat writes, audio annotations, verification clicks) are also under-instrumented, but they raise harder questions (per-click vs. per-session aggregation, edit noise, etc.). Scoping to jobs ships the felt gap quickly; non-job coverage gets its own brainstorm when it surfaces.

## Key Decisions

- **One event per job, on terminal transition.** Fires when `processing_jobs.status` moves to `completed`, `failed`, or `cancelled`. No queued/started events.
- **Severity mapping**: `completed` → `success`, `failed` → `error`, `cancelled` → `warn`.
- **Source field** picks the existing `EVENT_SOURCES` entry: `camera-trap` for CT job types, `audio` for audio job types. No new sources.
- **eventType naming**: `ct_ml.complete`, `ct_drive_sync.complete`, `ct_compression.complete`, `audio_birdnet.complete`, `audio_indices.complete`, `audio_sync.complete`, `audio_compression.complete`, `audio_revert_compression.complete` (status verb stays `complete` regardless of severity — severity is its own column, so consumers can filter).
- **Required `details` payload** for every job event: `jobId`, `jobType`, `deploymentId`, `processed`, `total`, `errorMessage` (if any), `durationMs` (derived from `startedAt`/`completedAt`), plus job-specific extras (e.g., `detectorModel`/`classifierModel` for ML, `speciesCount` for BirdNET). `targetType="processing_job"`, `targetId=jobId`.
- **`actorEmail`** comes from `processingJobs.createdBy` so the original requester is preserved even though the lifecycle event fires from a background context.
- **No new helper layer for now.** Each of the ~12 terminal-transition sites gets an explicit `recordEvent()` call. The original plan rejected centralizing job state behind a wrapper as "high-risk for marginal gain"; that judgment still applies — the call sites are simple and adding a wrapper would balloon the diff.
- **CLAUDE.md addition.** A new bullet under "Conventions" (or a new "Observability" subsection):

  > **System events.** When implementing or reviewing any server action or background job that mutates persistent state, consider whether the operation should call `recordEvent()` from `@/lib/system-events`. Default yes for: any `processing_jobs` terminal transition, destructive actions, admin/permission changes, bulk uploads, and cron job completions. Default no for: high-frequency per-row reads/writes (verification clicks, autosaves) where one-event-per-batch is more useful. If unsure, ask.

## Open Questions

- **Per-image / per-file errors** inside a job (e.g., one corrupted image inside an otherwise-successful ML run). Current decision: stay summarized in the single completion event's `details.failedImages`. Re-evaluate if individual-row failures start needing first-class visibility.
- **Cron job inserts that create processing jobs** (`nightly-refresh/route.ts:156, 490`): the cron itself already emits `cron_nightly_refresh`. The jobs it creates will fire their own lifecycle events on completion — confirm in the plan that this doesn't double-count the same action.
- **Cancellation paths**: some cancellations write `status="cancelled"` via background loops, others via explicit user action. Verify all cancellation sites get the event, not just the user-initiated ones.

## Next Steps

→ `/workflows:plan` to translate this into the concrete diff (12 lifecycle sites + CLAUDE.md edit + a small test that asserts each job type emits exactly one event on each terminal transition).
