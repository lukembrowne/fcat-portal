---
title: Speed up training-export + promote to tracked background jobs
type: feat
date: 2026-05-29
status: implemented
---

> **Implementation note (2026-05-29).** Implemented on `main` (not yet committed).
> All phases shipped: speed (group-by-imageId + `p-limit`, default 8), `<date>-vN`
> folders, two tracked job types (`training_export`, `training_export_upload`) with
> indeterminate upload progress, atomic single-flight claim, fire-and-forget with
> inner terminal-write + `eventEmitted` guard, dedicated `cancelTrainingExportJob`
> (routed before `cancelJob`), `recoverStuckJobs` fail-on-restart branch + orphaned
> tar cleanup, floating-bar branches, form/cell handoff to the bar. `npm run test:run`
> (1107 pass incl. coverage-guard) + `npm run build` green; changed files lint-clean.
> **Deferred:** dedicated unit tests for the loop internals (the logic lives in a
> `"use server"` module — would need helper extraction; pure helpers stay covered by
> `tests/unit/training-export.test.ts`). Server migration is not required (`jobType`
> is free-text, no schema change).

> **Revision note (post-review).** Revised after simplicity / architecture / Kieran-TS
> reviews. Key changes from v1: upload progress is **indeterminate** (byte→MB apparatus cut);
> a **dedicated `cancelTrainingExportJob`** replaces routing through `cancelJob` (which would
> crash on `deploymentId=null`); fire-and-forget gets an **inner terminal-write + `eventEmitted`
> idempotency guard**; `crops.csv` order made **deterministic** (index-into-`filtered`, no shared
> `push`); error handling reuses **`isRetriableDriveError` + `err.code === 'ENOSPC'`** (no message
> sniffing); single-flight is **atomic** (version allocated after the claim); the late-cancel
> "point of no return" contract, the pre-flight disk estimate, and the startup `.tmp` sweep are
> **cut**. See "Review revisions" at the end.

# ✨ Speed up training-export + promote to tracked background jobs

## Overview

The camera-trap **training-export** (crop generation) is slow and invisible. It runs as an
**awaited server action** that downloads each crop's full-res source image from Google Drive
**one at a time, sequentially**, and reports progress only to stdout. There is no progress bar,
no ETA, and no way to cancel.

This plan does two things:

1. **Speed it up** — group candidate detections by source `imageId` (download each full-res
   image **once** instead of once per crop), and fan out downloads with `p-limit` (the project's
   standard concurrency limiter). Expected **10–30×** speedup.
2. **Make it a first-class tracked job** — convert both the crop-generation export and the
   tar+upload-to-Drive step into rows in `biochoco_processing_jobs` so they appear in the
   **floating progress bar** with a determinate progress bar, `X de Y` counts, client-side ETA,
   live `statusMessage`, and a working **Cancel** button — exactly like ML / compression / drive-sync jobs.

This realizes the follow-up explicitly flagged in
`docs/plans/2026-05-28-feat-training-export-megadetector-metadata-drive-share-plan.md:273`
("If it proves too slow, promote to a `biochoco_processing_jobs` background job").

## Problem statement / Motivation

Measured on production (2026-05-29) while a v4 export of **13,694 crops** was running:

- **~0.8–1 crop/sec** → ETA **~3 hours** for one export.
- **125,952 of 126,834 images have no local copy** (only 882 do) — chunked ML processing deletes
  full-res cache files after inference, so nearly every crop falls through `loadImageBytes`
  (`actions.ts:1034`) to `downloadFileToBuffer(driveFileId)` — a fresh Drive round-trip per crop.
- The loop is `for (const row of filtered) { await loadImageBytes(row); await cropAndWrite(...) }`
  (`actions.ts:839-891`) — **fully serial**, and **re-downloads the same source image once per
  detection** (an image with 3 animals is fetched 3×).

Secondary pain: the export is an **awaited server action inside `useTransition`**
(`export-form.tsx:74-86`) — the browser request blocks for the entire run. A multi-minute (let
alone multi-hour) export hits proxy/server-action timeouts and gives the user zero feedback. The
only way to "cancel" today is to restart the container (which we did during diagnosis).

## Proposed solution

### Speed (the crop loop)

```
// src/app/camera-trap/training-exports/actions.ts — new processTrainingExportJobInternal()
// 1. Group candidates by source image so each Drive object downloads exactly once.
//    Keep each row's index in `filtered` so output stays deterministic.
const byImage = new Map<number, { row: CandidateRow; idx: number }[]>();
filtered.forEach((row, idx) => {
  if (!byImage.has(row.imageId)) byImage.set(row.imageId, []);
  byImage.get(row.imageId)!.push({ row, idx });
});

// 2. Bounded fan-out with p-limit (reuse the import shape from drive-sync-worker-core.ts).
//    DETERMINISM: write each crop's CSV row into a pre-sized slot at its `filtered` index;
//    never push into a shared array from inside a callback (completion order is non-deterministic).
const csvSlots: (CropCsvRow | null)[] = new Array(filtered.length).fill(null);
const limit = pLimit(EXPORT_DOWNLOAD_CONCURRENCY); // default 8, env CT_TRAINING_EXPORT_CONCURRENCY
let processed = 0; // in-memory monotonic counter (written + skipped + failed) → reaches filtered.length
await Promise.all([...byImage.values()].map((group) => limit(async () => {
  if (await isCancelled()) return;                 // cooperative cancel between images
  let buffer: Buffer;
  try { buffer = await loadImageBytes(group[0].row); } // ONE download for all crops of this image
  catch { warnGroup(group); processed += group.length; await maybeTick(); return; } // retries exhausted → skip group + warn
  for (const { row, idx } of group) {
    try { await cropAndWriteAtomic(buffer, row, outPath); csvSlots[idx] = buildRow(row, split); written++; }
    catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOSPC") throw err; // disk full → fail whole job
      warnings.push(...);                          // any other per-crop error: skip + warn
    }
    processed++; await maybeTick();                // maybeTick writes the ABSOLUTE `processed` every ~N crops
  }
})));
const csvRows = csvSlots.filter((r): r is CropCsvRow => r !== null); // stable, filtered-order
```

- **Determinism:** `crops.csv` is emitted in `filtered` order regardless of download-completion order
  (reviewers flagged shared-`push` non-determinism). `computeContentHash` runs *before* cropping and
  doesn't depend on CSV order, but stable output keeps re-exports byte-diffable.
- **Absolute progress counter:** throttled writes set the in-memory `processed` value, never a SQL
  `processedImages + 1` expression — so overlapping writes are last-writer-wins-safe and the bar
  reaches 100% exactly. `processed` advances on every *attempted* crop (written + skipped + failed).
- **Error handling reuses existing primitives:** `downloadFileToBuffer` already wraps `withRetry`
  (`drive-client.ts:692`; `isRetriableDriveError:1018` classifies 429/5xx by status code). When
  `loadImageBytes` throws, retries are already exhausted → skip the group + warn (no 404/403 message
  sniffing). The one fatal crop error is disk-full, detected via `err.code === 'ENOSPC'` (typed
  errno, never a message regex).
- **In-memory crops** (buffer → sharp → `.jpg`), never bulk-download-to-disk → no reintroduction of
  the 2026-05-25 disk-full risk (`incident_disk_full_biochoco_download`). Peak memory ≈
  `concurrency × one full-res image`.
- **Conservative default concurrency 8** (env-tunable): reads need no rate gate, but an unrelated ML
  job may be downloading simultaneously, so we stay well under the proven-50 batch ceiling.

### Tracking (two job types)

Both become rows in `biochoco_processing_jobs` (Drizzle `processingJobs`). `jobType` is **free text
with no DB CHECK → zero schema migration**.

| jobType | Unit | Progress source | Cancel |
|---|---|---|---|
| `training_export` | `recortes` | `processedImages` / `totalImages = filtered.length` (determinate bar + ETA) | flip status → `cancelled` |
| `training_export_upload` | — | **Indeterminate** (`totalImages=0`); phase shown via `statusMessage` ("Empaquetando…" → "Subiendo a Drive…") | flip status → `cancelled` |

> The upload is the *short* phase and `uploadLocalFileToSharedDrive` exposes no byte-progress callback,
> so per the simplicity + TS reviews we keep it **indeterminate** rather than inventing an MB counter
> (which would need a stream byte-tally, a custom unit, a bar branch, and a test). The `total===0`
> path already renders the pulsing indeterminate state — verify it degrades to indeterminate, not a
> stuck 0%. Streaming byte-progress is a clean additive change later if ever wanted.

The floating bar is **fully data-driven** (`/api/active-jobs` lists every `pending`/`processing`
row; `/api/progress?jobId=` SSE streams `processed/total/statusMessage`; ETA is computed
client-side from `processed/elapsed`). So progress + ETA come "for free" once we write the row and
tick its counters — we only add **display branches** (label, unit, no `/process` link) and the
**dispatch + cancel + recovery** wiring.

## Architecture / Technical approach

### Job lifecycle (crop export)

1. `exportTrainingDataset(formData)` (still `requireAdmin()`) validates params, runs
   `collectExportCandidates` + split assignment + `computeContentHash` **synchronously** (fast).
2. **contentHash short-circuit:** if a completed dataset with that hash exists → return
   `{ status: 'unchanged', version }` and **create no job row**.
3. **Single-flight guard (atomic):** one parameterized helper
   `findActiveTrainingExportJob(jobTypes)` (modeled on `findActiveSharedDriveReconcileJob`,
   `job-locks.ts:137`), but the *load-bearing* guard must be atomic — **insert the job row first via
   a conditional `INSERT … WHERE NOT EXISTS(active row of this type)`** (mirroring the spirit of
   `tryClaimJob`, `job-queue.ts:56`), and **allocate `version` + `mkdir` only after the claim is
   won**. This closes the real race the reviewers flagged: two simultaneous exports must not both run
   a full multi-minute loop and both compute `version = max(id)+1` (the `version` + `content_hash`
   UNIQUE constraints only fire at the *final* insert, after the wasted work). UNIQUE is
   defense-in-depth, not the guard.
4. **contentHash short-circuit happens first** (step 2) and creates no job row. If a claim is won,
   persist split assignments (existing sync `db.transaction`) and insert the `training_export` row
   (`status='processing'`, `totalImages = filtered.length`, `deploymentId=null`,
   `createdBy=user.email`). The action returns
   **`ActionResult<{ kind: 'unchanged'; version: string } | { kind: 'started'; jobId: number; version: string }>`**
   — errors are `{ success: false, error }` (never thrown strings); the form narrows on
   `result.success` then on `data.kind`.
5. **Fire-and-forget with a guaranteed terminal write.** Dispatch
   `void processTrainingExportJobInternal(jobId).catch(...)`, NOT enqueued in `QUEUEABLE_JOB_TYPES`
   so it never blocks ML. Contract (reviewers flagged swallowed failures):
   - `processTrainingExportJobInternal` wraps its whole body in `try/catch`; the **inner catch writes
     the `failed` row** (status + Spanish `errorMessage`) before returning.
   - The **outer `.catch()` is a last-resort net that ALSO writes the terminal row** (covers a throw
     during setup before the inner handler), then logs.
   - An **`eventEmitted` idempotency flag** (mirror `processJobInternal`, `actions.ts:324-333`)
     ensures `recordEvent(buildJobCompletionEvent(job))` fires exactly once across both sites.
6. Background loop crops (parallelized, above), throttling absolute-`processed` DB writes
   (`statusMessage = "Generando recortes... (N de M)"`), polling `isCancelled()` between images.
7. On success: write `manifest.json` + `crops.csv`, insert the dataset row (sync `db.transaction`),
   then immediately set job `status='completed'`, `completedAt`, and emit the completion event.
8. On cancel/failure: set terminal status + Spanish `errorMessage`; leave the partial `versionDir`
   on disk (resume substrate); do **not** insert a dataset row.

### Job lifecycle (upload)

`packageAndUploadExport(version)` becomes: validate (regex on the `version` param — see below) +
single-flight on `training_export_upload` (one upload at a time) → insert the job row → return
`{ jobId }` → fire-and-forget. The upload is naturally blocked while the version is mid-export because
it **requires the dataset row, which is inserted last** — so no separate "refuse if an export is
active" scan is needed (cut per simplicity review). Background work: derive folder + archive name
**from the dataset's stored `manifestPath`** (`dirname`/`basename`) so the archive name always matches
the on-disk folder (and legacy `vN` folders still work) → `tar` into a real volume path under `data/`
(not `os.tmpdir()`, to avoid a multi-GB tmpfs/memory hit), `statusMessage="Empaquetando…"`
(indeterminate) → `statusMessage="Subiendo a Drive…"`, stream upload → persist
`driveArchiveFileId/webViewLink/archiveUploadedAt`, delete prior archive → `completed`. Temp tar
removed in `finally`; on cancel/fail, delete the just-created Drive file if an id came back, and
**never** delete the prior good archive.

> **Version validation / `tar -C` seam.** The existing `/^v\d+$/` allowlist (`actions.ts:1115`)
> guards the `version` param interpolated into a `tar -C EXPORT_ROOT <folder>` arg. Keep the
> allowlist on the `version` param; the folder name comes from `basename(manifestPath)`. `execFile`
> (no shell) already prevents injection — don't drop either guard.

### Crash-safe idempotent resume

- `cropAndWriteAtomic`: write to `outPath + '.tmp'`, then `fs.rename` (atomic on same FS). Skip a crop
  only if `outPath` exists **and size > 0**. Single-flight guarantees no concurrent writer, so the
  exists-check is race-free. A leftover `.tmp` from a kill is harmless (the skip-check looks at
  `outPath`, and the next run overwrites the same `.tmp` before renaming) — **no startup sweep
  needed** (cut per simplicity review).

### Restart recovery (decision: fail + easy retry)

`recoverStuckJobs()` (`src/db/index.ts:173`) is **synchronous** (better-sqlite3) and currently selects
only `status='processing'` rows, flipping them → `pending` then draining the *queueable* picker.
Since these job types are **not queueable**, that flip would strand them at `pending` forever. **Add a
synchronous branch before the generic flip:** a `processing` `training_export` /
`training_export_upload` row at boot → set `status='failed'`,
`errorMessage='Exporte/Subida interrumpido(a) por reinicio del servidor.'` (these jobs are inserted
directly as `processing`, never `pending`, so the existing select is sufficient — no need to widen
it). The partial `versionDir` persists; re-submitting identical params finishes fast via
skip-existing. The existing temp sweep filters `ct-job-*` under `TEMP_BASE`, so it never touches
`data/training-exports/` — but the upload job's tar must be cleaned up: write it under `data/` and
remove it in `finally`, and have recovery delete any orphaned `data/.../training-export-*.tar.gz`.

### Cancel wiring

- **Dedicated `cancelTrainingExportJob(jobId)`**, NOT the existing `cancelJob`. The floating bar
  routes single-job cancels to `cancelProcessingJob` (`audio/actions.ts:749`), which currently falls
  through to camera-trap `cancelJob` (`actions.ts:1138`). That path is **hostile to a
  `deploymentId=null` job** — it calls `requireDeploymentAccess(job.deploymentId!)`, fires
  `cancelModelServerJob`, and **deletes detections/images by `jobId`** (all reviewers flagged this).
  So: add an **explicit early branch in `cancelProcessingJob`** for the two new job types *before* the
  `cancelJob` fallthrough, delegating to `cancelTrainingExportJob` (co-located in
  `training-exports/actions.ts`). That function: load row → if already terminal, **idempotent no-op
  success** → else flip `status='cancelled'` + `recordEvent`. Guard `if (job.pid) process.kill(...)`
  (export jobs have `pid=null`).
- **Permission:** use `requirePermission("camera-trap", "editor")` (project-level — these jobs have
  `deploymentId=null`, so `requireDeploymentAccess` is wrong). This matches the bar's `canCancel`
  (`/api/active-jobs:30`, editor+) so the shown button actually works. **Deliberate relaxation:** a
  camera-trap *editor* can cancel an admin-started export. Low-stakes (cancel just stops a job), but
  flagged as an explicit auth-boundary choice — see "Open decision" below.
- **Late-cancel:** the dataset insert and `status='completed'` happen back-to-back at the very end,
  so the "dataset exists but not yet completed" window is sub-millisecond. No cross-component "refuse
  if dataset row exists" contract (cut per simplicity review) — the idempotent "no-op if terminal"
  rule already covers the only case that matters.

### Registration (no DB migration)

- `src/lib/job-types.ts` — add `TRAINING_EXPORT: "training_export"`, `TRAINING_EXPORT_UPLOAD: "training_export_upload"` to `JOB_TYPES`. (`jobType` is free text in the DB, but the `JobType` union is typed — adding the literals here is the compile-time forcing function for the next bullet.)
- `src/lib/system-events.ts` — add both to `JOB_LABELS` ("Exporte de entrenamiento", "Subida de exporte"). `JOB_LABELS` is `Record<JobType, string>`, so **the build itself fails** until both are added (stronger than the coverage-guard test, which also passes). Do **NOT** add to `AUDIO_JOB_TYPES` (would misroute to the audio source). `jobSourceAndProject` defaults non-audio/null-deployment types to `source:"camera-trap"`, `scope:"Todos los proyectos"` (`system-events.ts:121-133`) — accept that scope wording or add a dedicated branch for nicer text.
- `src/lib/job-display.ts` — add `fallbackDisplayName` cases (these jobs have no deployment/project name).
- `src/components/floating-job-progress.tsx` — add `isTrainingExport` / `isTrainingExportUpload` to the **`isLinkable` exclusion** (line 181, currently exclusion-based → both would wrongly link to `/process` & `/results`); set `unitLabel` to `recortes` for the crop job; ensure the upload job renders **indeterminate** (`total===0` path, no unit); add Spanish completed/failed/cancelled text. Optionally add to `progress-tracker.tsx` if used full-page.

### Adjacent change (already decided, same files)

On-disk export folder becomes **`<YYYY-MM-DD>-vN`** (e.g. `2026-05-29-v4/`) so it sorts
chronologically and matches the Drive archive name; the DB `version` stays the logical `vN`. The
upload job derives folder + archive name from `dirname/basename(dataset.manifestPath)`, so legacy
`v1`/`v2`/`v3` folders still archive correctly as `v1.tar.gz` etc. New exports only; no rename of
existing folders. (This was the in-flight edit when the plan was requested.)

## Implementation phases

### Phase 1 — Speed + correctness (no UI dependency)
- Group-by-`imageId` + `pLimit(EXPORT_DOWNLOAD_CONCURRENCY)` crop loop; `cropAndWriteAtomic` (.tmp+rename, size>0 skip); ENOSPC → fail, 404 → skip+warn.
- `<date>-vN` folder naming; upload derives names from `manifestPath`.
- Unit tests for grouping, skip-existing, atomic write, folder-name helper.

### Phase 2 — Job model + dispatch
- `JOB_TYPES` + `JOB_LABELS` + `fallbackDisplayName` registration (build fails until labels added).
- One parameterized `findActiveTrainingExportJob(jobTypes)` in `job-locks.ts`; **atomic claim** (conditional `INSERT … WHERE NOT EXISTS`), version+mkdir after the claim.
- `exportTrainingDataset` → validate-sync, no-op short-circuit, atomic claim/insert, return the `ActionResult<{kind:'unchanged'|'started', …}>` union; fire-and-forget `processTrainingExportJobInternal` with inner terminal-write + `eventEmitted` guard; throttled absolute-counter progress writes; `isCancelled` polling.
- `packageAndUploadExport` → job row + tar-into-`data/` + indeterminate stream upload; clean tar in `finally`.
- `recoverStuckJobs` synchronous branch → mark these types `failed` on boot; delete orphaned tar.

### Phase 3 — UI + cancel
- `floating-job-progress.tsx` branches (linkable exclusion, `recortes` unit for crop, indeterminate for upload, status text).
- `cancelTrainingExportJob` (co-located) + an early branch in `cancelProcessingJob` *before* the `cancelJob` fallthrough; `requirePermission("camera-trap","editor")`; `if (job.pid) kill`; idempotent no-op on terminal.
- `export-form.tsx`: on `kind:'unchanged'` show the existing "ya existía como vN" card; on `kind:'started'` fire `window.dispatchEvent(new Event('job-started'))` and hand off to the bar (remove the synchronous-completion inline UI).
- `export-archive-cell.tsx`: fire `job-started` on upload click; `router.refresh()` on `jobs-updated` terminal so "Abrir en Drive" appears without a manual reload. Preserve the sortable history table.

### Phase 4 — Deploy + verify
- `npm run test:run`, `npm run lint`, `npm run build`, `docker compose build`.
- Deploy; confirm a real export shows in the bar with ETA, completes ~10–30× faster, is cancellable, and survives a mid-run restart as `failed` (then retries fast).

## Acceptance criteria

### Functional
- [ ] A new export creates a `training_export` job, returns `jobId` immediately, and appears in the floating bar with a determinate bar, `X de Y recortes`, ETA, and live `statusMessage`.
- [ ] Each source image is downloaded **once** regardless of how many crops it yields; downloads run with bounded concurrency (`CT_TRAINING_EXPORT_CONCURRENCY`, default 8).
- [ ] contentHash no-op returns `{status:'unchanged', version}` and creates **no** job row.
- [ ] Single-flight: a second concurrent export (or a second upload) is refused with a Spanish message.
- [ ] Cancel flips the job to `cancelled`; the loop stops within one batch; no dataset row is inserted; the partial folder is left for retry.
- [ ] tar+upload runs as a `training_export_upload` job (indeterminate progress with phase `statusMessage`), is cancellable, and on completion the history row shows "Abrir en Drive" without a manual reload.
- [ ] Mid-run server restart marks the job `failed` ("interrumpido por reinicio"); re-submitting identical params resumes fast (skips existing crops).
- [ ] New export folders are named `<date>-vN`; the uploaded archive name matches the on-disk folder; legacy `vN` folders still archive correctly.

### Non-functional / quality
- [ ] `processedImages` is monotonic and reaches `totalImages` even when some crops are skipped/failed; progress DB writes throttled (every ~50 crops) to respect `busy_timeout`.
- [ ] In-memory cropping only (no bulk-download-to-disk); ENOSPC fails the job with a Spanish message rather than emitting thousands of warnings.
- [ ] Truncated-`.jpg` cannot be mistaken for done (atomic `.tmp`→rename + size>0 skip).
- [ ] `crops.csv` row order is deterministic across identical re-exports (index-into-`filtered`, not shared push).
- [ ] Cancelling an export routes to `cancelTrainingExportJob`, **never** `cancelJob` (no detection deletion / no `deploymentId!` crash).
- [ ] Fire-and-forget failure always writes a terminal row (inner catch + outer net), event emitted exactly once.
- [ ] Floating bar shows correct unit label (crop) / indeterminate (upload) and **no** broken `/process`/`/results` links.
- [ ] Build is green (the `Record<JobType,string>` `JOB_LABELS` forces both labels); coverage-guard test passes; `docker compose build` green.

## Edge cases (from flow analysis)

- **Download fails for a source image** (404/403/exhausted retries) → skip that image's whole crop group + warn; do not fail the job. No message sniffing — `withRetry` already classifies/retries transient 429/5xx (`isRetriableDriveError`), so a thrown error is effectively permanent.
- **Disk fills mid-crop** → `err.code === 'ENOSPC'` → fail job ("Sin espacio en disco"). No pre-flight disk estimate (cut — crop sizes aren't known up front; ENOSPC is the real, simple guard).
- **Dataset insert fails after crops written** → fail job, retain folder for cheap idempotent retry (skip-existing).
- **Two admins click Export at once** → the **atomic claim** (conditional insert) lets only one win; the loser gets a Spanish "ya hay un exporte en curso". `version`/`content_hash` UNIQUE are defense-in-depth, not the guard (they'd only fire after a full wasted run).
- **Version/orphan-folder collision** after cancel/crash (no DB row consumed the `vN`) → because `version` is allocated *after* the won claim and `mkdir` is guarded, and the partial folder is reused on retry via skip-existing.
- **Upload while same version mid-export** → blocked because the dataset row (required by upload) doesn't exist until the crop job's final insert.
- **Export + unrelated ML job concurrently** → allowed; export never touches the ML queue. Conservative download concurrency since both contend for Drive read quota / disk.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| `recoverStuckJobs` strands non-queueable export at `pending` | Synchronous branch → `failed` on boot (Phase 2). |
| Cancel routed to `cancelJob` corrupts a null-deployment job | Dedicated `cancelTrainingExportJob` branched before fallthrough. |
| Fire-and-forget swallows a failure / double-emits event | Inner terminal-write + outer net + `eventEmitted` guard. |
| Non-deterministic `crops.csv` order | Pre-sized array indexed by `filtered` position. |
| Truncated `.jpg` shipped on resume | Atomic `.tmp`→rename + size>0 skip. |
| Broken bar links / wrong unit | Explicit `isLinkable` exclusion + unit/indeterminate branches. |
| Two concurrent exports waste a full run | Atomic claim (conditional insert), version alloc after claim. |
| Concurrency amplifies Drive 429s | Default 8, env-tunable, `withRetry` backoff. |
| Large `.tar.gz` in tmpfs fills memory | tar into `data/` (real volume), clean in `finally` + recovery. |

## Open decision (for the user)

- **Cancel permission.** Start is `requireAdmin()`; the floating bar's Cancel is camera-trap
  **editor+**. The plan lets editors cancel admin-started exports (so the shown button works, parity
  with other CT jobs). If you'd rather keep cancel **admin-only**, we instead gate the bar's button
  for these job types — slightly more UI plumbing. Default: **editor+** (low-stakes; cancel only
  stops a job).

## Review revisions (v1 → reviewed)

Folded in from simplicity / architecture / Kieran-TS reviews:
- **Cut** the byte→MB upload progress apparatus → upload is indeterminate.
- **Cut** the late-cancel "point of no return" cross-component contract → idempotent no-op-if-terminal only.
- **Cut** the pre-flight disk estimate and the startup `.tmp` sweep (both speculative; ENOSPC + `.tmp`-overwrite already cover them).
- **Fixed (correctness):** dedicated `cancelTrainingExportJob` (not `cancelJob`); synchronous `recoverStuckJobs` branch (select already covers `processing`-only); fire-and-forget inner terminal-write + `eventEmitted` idempotency; deterministic `crops.csv`; absolute progress counter; `isRetriableDriveError` + `err.code==='ENOSPC'` (no message sniffing); **atomic** single-flight claim with version-after-claim; explicit `tar -C` regex retention; tar into `data/` not `os.tmpdir()`.
- **Named** the `ActionResult<{kind:'unchanged'|'started', …}>` discriminated union.

## Testing
- **Unit:** group-by-image dedup; skip-existing/atomic write; folder-name helper; ENOSPC vs 404 classification; upload byte→MB mapping; coverage-guard.
- **Integration (mock DB + mock Drive):** job row created/returned; progress ticks; cancel flips status and loop stops; recovery marks failed; no-op creates no row.
- **Manual/E2E on server:** real export shows in bar + ETA, ~10–30× faster, cancellable, restart→failed→fast retry; upload job + Drive link refresh.

## References

### Internal (file:line)
- Serial crop loop: `src/app/camera-trap/training-exports/actions.ts:839-891`; `loadImageBytes:1034`; `cropAndWrite:1054`; `exportTrainingDataset:654`; `packageAndUploadExport:1109`.
- Form (awaited): `src/app/camera-trap/training-exports/export-form.tsx:74-86`; archive cell: `export-archive-cell.tsx`; history table: `page.tsx`.
- Job table + status CHECK: `src/db/schema.ts:217-257`, `:416` (content_hash UNIQUE); `scripts/push-schema.mjs:81`, `:558`.
- Floating bar / progress: `src/components/floating-job-progress.tsx:163-188`, `:181` (isLinkable), `:200-216` (ETA); `src/hooks/use-active-jobs.ts`; `src/app/api/progress/route.ts`; `src/app/api/active-jobs/route.ts:30`.
- Dispatch/queue/recovery: `src/lib/job-queue.ts:27-39`; `src/db/index.ts:173-267` (`recoverStuckJobs`), `:152`.
- Locks: `src/lib/job-locks.ts:137-151` (`findActiveSharedDriveReconcileJob` — clone for export).
- Cancel: `src/app/audio/actions.ts:749` (`cancelProcessingJob`); `src/app/camera-trap/actions.ts:286-292` (`isJobStillActive`), `:368-372` (`checkCancelled`).
- Registration: `src/lib/job-types.ts:10-24`; `src/lib/system-events.ts:74,83`; `src/lib/job-display.ts:41`; guard `tests/unit/system-events.test.ts:347`.
- Concurrency precedent: `src/lib/drive-client.ts:635-687` (`downloadDeploymentImages` batch); `src/lib/drive-sync-worker-core.ts:246` (`p-limit`); `downloadFileToBuffer:692`, `withRetry:1041`.

### Related work
- Prior plan (pre-flagged this follow-up): `docs/plans/2026-05-28-feat-training-export-megadetector-metadata-drive-share-plan.md:273`.
- Disk-full incident (why in-memory cropping, not bulk-download): `incident_disk_full_biochoco_download` (memory).
- Conventions: CLAUDE.md "Processing job UX" (determinate bar + ETA + rich logging + statusMessage); "Camera-trap ML processing" (chunked downloads, `recoverStuckJobs`).
