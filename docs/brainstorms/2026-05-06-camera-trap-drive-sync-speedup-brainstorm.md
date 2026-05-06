---
date: 2026-05-06
topic: camera-trap-drive-sync-speedup
---

# Camera Trap Drive Sync — Speed, Scope, and Scheduling

## Production State (verified 2026-05-06)

Read prod log `/root/opt/fcat-portal/data/nightly-refresh.log` and confirmed installed crontab.

- **Nightly cron is running and succeeding** at 01:00 Eastern. Every recent run reports `ok:true, errors:0`.
- **Scale:** 101 deployments managing ~1.4 TB across BioChoco.
- **Sequential runtime:** ~366s (≈6 min) last night; has scaled linearly from 200s at 26 deployments to 366s at 101. Will keep getting worse.

**Critical finding — the cron is shallow.** It calls only `checkDeploymentUploads()` (file counts/sizes/newest dates) and emails a snapshot. It does **not** do the work the camera-trap UI actually depends on. That work lives in the manual `syncWithDrive()` server action, which additionally:

- Discovers new Drive folders → inserts new deployment rows.
- Calls `scanDeploymentImages()` → ingests image rows used by the annotation UI.
- Calls `matchOdkDeployments()` → auto-fills site / lat / lng / dates from ODK.
- Updates the "Última sincronización" timestamp shown on the deployments page.

This explains the "8 days since last update" observation: nothing was broken — the manual button just hadn't been clicked.

## What We're Building

Four changes:

1. **Move the full manual-sync workload into the nightly cron.** Nightly should run the same work as the button: folder discovery, image scan, ODK match, count refresh, snapshot + email. This solves "fresh data when I log in" without requiring anyone to click anything.
2. **Background job for the manual sync.** The button enqueues a background job (same pattern as ML jobs / `floating-job-progress.tsx`) so the user can navigate away. The nightly cron triggers the same code path.
3. **Parallelism across deployments.** Replace the sequential `for (const dep of allDeployments)` loops with concurrent execution (e.g., `p-limit` at 5–10). Applies to both the count-refresh path and the per-deployment scan/ODK match. At concurrency=10, the ~6-min nightly drops to roughly ~40s; manual sync sees the same factor.
4. **Per-CT-project scope in the UI.** Split-button next to "Sincronizar con Drive" — main action stays "sync everything"; dropdown lets you pick one CT project. `syncWithDrive(cameraTrapProjectId)` already supports this; only the UI is missing.

## Why This Approach

- **Full nightly work** directly fixes the "stale UI" complaint. No discipline-dependent manual clicking.
- **Parallelism over incremental sync.** Predictable, no skip-if-recent edge cases, no Drive Changes API state. Defer those unless parallelism alone proves insufficient.
- **Background job over foreground.** User wants to navigate away. The codebase already has the pattern (ML, compression, revert) per `CLAUDE.md` memory — reuse, don't reinvent. Single code path means the cron just enqueues the same job.
- **Split-button** is the lowest-friction UI for opt-in per-project scoping; backend already supports it.

## Key Decisions

- **Single sync code path** shared by manual button and nightly cron — both enqueue the same background job.
- **Concurrency model:** parallel within a sync run (across deployments). Limit TBD by quick measurement against Drive API quotas — starting at 5–10.
- **Job pattern reuse:** determinate `X de Y` progress, ETA, cancel, Docker logging with batch timing/throughput, per the convention in memory.
- **Email report stays attached to nightly** (not manual sync) — cron triggers the job, then reads the result snapshot and sends the email exactly as today.
- **Out of scope (deferred):** skip-if-recent caching, Drive Changes API, scoping by top-level project (we scope by CT project), changes to the email template, replacing `scanDeploymentImages` internals.

## Open Questions

- **Concurrency limit:** quick spike — what's the sweet spot before Drive API throttling? Start at 5, measure, raise if safe.
- **Long-running nightly safety:** today's nightly takes ~6 min sequentially; with full sync work added but parallelized it should still be well under the cron's `--max-time 600`. Confirm with a dry run on prod numbers.
- **Cancellation semantics:** if the user cancels a manual run mid-flight, partial progress (per-deployment) should persist — matching existing job conventions.
- **Concurrency lock:** can a manual run start while the nightly is still going? Likely a single-job lock; pick semantics during planning.
- **`scanDeploymentImages` cost at scale:** for nightly, scanning all deployments every night may be heavier than today's count-only refresh. Need to benchmark and decide whether to scan only newly-discovered deployments nightly vs. all of them.

## Next Steps

→ Run `/workflows:plan` to break the four changes into implementation steps, including a benchmark step for concurrency and `scanDeploymentImages` cost.
