# Compression Progress Feedback Design

## Problem

Image compression runs as a blocking server action with only a spinner. No progress indication, no Docker logs, and the user can't navigate away.

## Solution

Treat compression as a background job using the existing `processingJobs` infrastructure. Same table, API, SSE, and FloatingJobProgress toast.

## Schema

Add `jobType` column to `processingJobs`:

```sql
job_type TEXT NOT NULL DEFAULT 'ml'   -- 'ml' | 'compression'
```

Existing rows default to `'ml'`. No data migration needed.

## Server-Side

### Enqueue action (`compressDeploymentImages`)

Becomes a thin enqueue function:
1. Insert job row: `jobType: 'compression'`, `totalImages: N`, `status: 'pending'`
2. Fire-and-forget `compressJobInternal(jobId)`
3. Return `{ jobId }` immediately

### Background worker (`compressJobInternal`)

1. Set job `status: 'processing'`, record `startedAt`
2. Loop batches of 5 images:
   - After each batch: update `processedImages` and `statusMessage` (e.g., "Comprimiendo... 15 de 100")
   - Console log: `[compress] Deployment 42: batch 3/20 — 15/100 images, 12.3 MB saved`
3. On completion: `status: 'completed'`, statusMessage with summary, log totals
4. On error: `status: 'failed'`, `errorMessage`, log error

### Docker logging format

```
[compress] Deployment 42: starting — 100 images to compress
[compress] Deployment 42: batch 3/20 — 15/100 images, 12.3 MB saved so far
[compress] Deployment 42: complete — 95 compressed, 5 skipped, 38.2 MB saved (2m 14s)
```

## Client-Side

### FloatingJobProgress toast

No structural changes. Already works with any pending/processing job. Minor tweaks:
- Hide "Ver detalles" / "Ver resultados" links for compression jobs (no results page)
- Show compression summary on completion instead of results link

### Expanded row button

- Returns immediately after enqueueing
- Dispatches `"job-started"` event so toast picks it up
- Button disabled while compression job is active for that deployment

## Files to modify

1. `src/db/schema.ts` — add `jobType` column
2. `scripts/push-schema.mjs` — add column to CREATE TABLE
3. `src/app/camera-trap/drive-actions.ts` — refactor into enqueue + background worker
4. `src/app/camera-trap/deployment-expanded-row.tsx` — update button to enqueue and dispatch event
5. `src/components/floating-job-progress.tsx` — hide results links for compression jobs
6. `src/app/api/active-jobs/route.ts` — include jobType in response
7. Test DDL — add jobType column
