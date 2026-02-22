---
title: "feat: Display processing job duration"
type: feat
date: 2026-02-18
---

# feat: Display processing job duration

## Overview

Add processing duration to the camera trap job UI everywhere jobs are shown. The `startedAt` and `completedAt` timestamps already exist in the database — they just aren't exposed to the UI. For completed jobs, show `completedAt - startedAt`. For in-progress jobs, show a live elapsed timer based on `startedAt` and the current time.

Format: relative time — "2m 34s", "1h 15m 22s", "45s".

## Acceptance Criteria

- [x] Duration shown in the individual job results page header (after status badge)
- [x] Duration shown as a sortable column in the results list table
- [x] Live elapsed time shown in the floating job progress toast widget
- [x] Live elapsed time shown on the process page (`/camera-trap/process?jobId=X`)
- [x] Format: relative time — "2m 34s", "1h 15m 22s", "45s"
- [x] For in-progress jobs: live ticking timer since `startedAt`
- [x] For pending jobs: show "—"
- [x] For completed/failed/cancelled jobs: show final `completedAt - startedAt`

## Implementation

### 1. Add `formatDuration` utility

**File:** `src/lib/format-duration.ts` (new)

```typescript
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}
```

### 2. Add `startedAt` to SSE progress API and active-jobs API

**File:** `src/app/api/progress/route.ts` (line 60-67)

Add `startedAt` to the SSE event data:

```typescript
sendEvent({
  jobId: job.id,
  status: job.status,
  processed: job.processedImages,
  total: job.totalImages,
  failed: job.failedImages,
  statusMessage: job.statusMessage,
  startedAt: job.startedAt?.toISOString() || null,  // ADD
});
```

**File:** `src/app/api/active-jobs/route.ts` (line 30-38)

Add `startedAt` to the active jobs response:

```typescript
const result = activeJobs.map((job) => ({
  ...existing fields...,
  startedAt: job.startedAt?.toISOString() || null,  // ADD
}));
```

### 3. Add live elapsed timer to floating job progress widget

**File:** `src/components/floating-job-progress.tsx`

- Add `startedAt` to the `ActiveJob` interface (line 9)
- Add `startedAt` to the `SSEData` interface (line 19)
- Add a `useEffect` with a 1-second interval that re-renders elapsed time while processing
- Display elapsed time in the widget body, after the progress bar text (line 370 area)
- For completed jobs, calculate final duration from `startedAt` and the terminal event time

### 4. Add live elapsed timer to progress tracker (process page)

**File:** `src/components/progress-tracker.tsx`

- Add `startedAt` to the `ProgressData` interface (line 8)
- Add a `useEffect` with a 1-second interval for live elapsed display
- Display elapsed time below the progress bar, next to the image count line (line 174 area)

### 5. Serialize `startedAt`/`completedAt` to results list page

**File:** `src/app/camera-trap/results/page.tsx` (lines 24-39)

Add to the `serializedJobs` mapping:

```typescript
startedAt: job.startedAt?.toISOString() || null,
completedAt: job.completedAt?.toISOString() || null,
```

### 6. Add duration column to results list table

**File:** `src/app/camera-trap/results/results-table.tsx`

- Add `startedAt: string | null` and `completedAt: string | null` to `ResultsJob` interface
- Add `"duration"` to `SortKey` type
- Add a "Duración" sortable column header after "Fecha"
- Render calculated duration in each row using `formatDuration`
- Sort by computed duration (completedAt - startedAt) when sorting by duration column

### 7. Add duration to individual job results header

**File:** `src/app/camera-trap/results/[id]/page.tsx` (lines 159-168)

Add duration display after the status badge, before the image count:

```tsx
{job.startedAt && job.completedAt && (
  <span className="text-muted-foreground">
    {formatDuration(new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime())}
  </span>
)}
```

## Files Changed

| File | Change |
|------|--------|
| `src/lib/format-duration.ts` | New — utility function |
| `src/app/api/progress/route.ts` | Add `startedAt` to SSE events |
| `src/app/api/active-jobs/route.ts` | Add `startedAt` to response |
| `src/components/floating-job-progress.tsx` | Live elapsed timer in toast |
| `src/components/progress-tracker.tsx` | Live elapsed timer on process page |
| `src/app/camera-trap/results/page.tsx` | Serialize startedAt/completedAt |
| `src/app/camera-trap/results/results-table.tsx` | Add duration column + sort |
| `src/app/camera-trap/results/[id]/page.tsx` | Add duration to header |

## Notes

- No schema changes needed — `startedAt` and `completedAt` already exist and are populated
- No new queries needed — `getRecentJobs()` already returns full job objects via `...job` spread
- The `formatDuration` utility is kept simple (no libraries) since we only need hours/minutes/seconds
- The live timer uses a 1-second `setInterval` — lightweight and only active while a job is processing
- The SSE progress API already sends events every 500ms, so `startedAt` is piggybacked efficiently
