---
date: 2026-05-13
topic: unified-system-activity-log
---

# Unified System Activity Log

## What We're Building

A single admin-facing view that surfaces major activity across the whole portal — processing jobs, destructive user actions, cron runs, and admin/ingestion events — in one chronological, filterable timeline. Today this information is split between two places: the "Trabajos de ML" jobs table (DB-backed, structured, camera + audio combined) and "Registros del sistema" (a raw Pino log stream from files). Several event sources aren't recorded anywhere durable (cron runs, admin role changes, finance/climate uploads).

The new page (`/admin/activity` or similar — name TBD) sits alongside the existing log viewer, doesn't replace it, and is admin-only. Each row is rich: timestamp, actor, module, action, target (clickable when applicable), duration, status, and a JSON drilldown blob. Retention is indefinite — SQLite handles this comfortably at portal scale.

## Why This Approach

We considered three options:

- **A — Read-time UNION** of existing tables. Cheapest now but gets gnarly as event sources multiply, and cron writes still need a home, so it doesn't actually avoid the new-writes work.
- **B — New `system_events` table, migrate everything. ✅ Chosen.** Clean long-term single source of truth.
- **C — Use the existing `activity_log` table as the event log; jobs queue stays separate.** Smallest practical change, but accepts long-term coexistence of two related tables.

We picked **B** because the codebase will gain more event sources over time, and the user prefers a structurally clean schema even at higher migration cost. A single `system_events` table with a discriminator column and a typed `details` JSON keeps the read path simple and gives every future module one well-known place to write.

## Key Decisions

- **One unified table (`system_events`)** with columns roughly: `id`, `occurredAt`, `eventType` (enum), `module` (audio/camera-trap/admin/cron/finance/climate/odk), `actorEmail` (nullable — system events have none), `projectId` (nullable), `targetType`, `targetId`, `status` (info/success/warn/error), `durationMs` (nullable), `summary` (short human string), `details` (JSON blob).
- **Scope of events recorded:**
  - Job lifecycle: started, completed, failed, cancelled (for ML, BirdNET, acoustic indices, audio compression/revert, audio sync, drive sync)
  - Destructive user actions: deletions, reverts, share-link revocations (the existing `activity_log` set, expanded)
  - Cron runs: DB backup, nightly BioChoco refresh, daily reminders, monthly digest — each writes a row with duration + status
  - Admin/ingestion: role changes, project creation, ODK syncs, finance CSV uploads, climate uploads
  - **Explicitly out of scope:** raw login events and auto-promoted Pino warn/error rows (rejected as too noisy for v1).
- **Existing log viewer stays.** Pino file stream remains the deep-debugging surface. The activity page links into it for context where useful.
- **Admin-only access.** Same gate as `/admin/logs`. No per-project view in v1 (can be added later if editors ask).
- **Rich rows, indefinite retention.** No auto-pruning. We can add a configurable retention cron later if the table ever gets large enough to matter.
- **Writer ergonomics matter.** A single `recordEvent({ ... })` helper that every module imports — this is what makes "one source of truth" actually hold over time, instead of drifting back into ad-hoc inserts.

## Open Questions (for the planning phase)

- **How does `system_events` relate to `biochoco_processing_jobs` and `activity_log`?**
  - Option 1: Migrate both into `system_events` and drop the old tables. Cleanest, biggest blast radius — `biochoco_processing_jobs` is queried heavily by the camera-trap module for in-flight queue state, progress bars, and single-flight locks (`src/lib/job-locks.ts`).
  - Option 2: Keep `biochoco_processing_jobs` as an *ephemeral queue* (in-flight state, progress, PID) and emit a `system_events` row only on lifecycle transitions. Migrate `activity_log` fully into `system_events` (it's already a near-perfect superset).
  - Option 2 looks lower-risk; planning should validate. Either way the user-visible answer is "one events table for the activity page."
- **Backfill?** Do we want to populate `system_events` with historical job + activity_log rows on first deploy, or only record events going forward? Backfill is a one-shot script; "forward-only" is simpler.
- **Cron writers:** cron scripts run from `scripts/*.mjs` outside the Next.js process. They'll need a small DB-write helper they can import without dragging in the whole app — confirm one exists or design one.
- **Filtering UX:** module + event type + status + actor + date range are obvious. Free-text search over `summary` + JSON `details`? Useful but watch SQLite FTS scope.
- **Realtime vs polled?** The existing log viewer uses SSE. Activity table is probably fine with a "Refresh" button + pagination — confirm before adding streaming complexity.
- **Permissions changes are sensitive.** Do role-change events show the old role → new role in `details`? Probably yes for audit value.

## Next Steps

→ `/workflows:plan` for implementation details (table schema, helper API, migration of `activity_log`, list of writer call-sites, page UI).
