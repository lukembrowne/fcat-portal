---
title: Fix camera trap scan/process workflow for 0-image and stuck deployments
type: fix
date: 2026-02-14
---

# Fix Camera Trap Scan/Process Workflow

## Overview

Three related issues in the camera trap workflow cause deployments to get stuck in unrecoverable states:

1. **Bug**: Deployments get permanently stuck in "Procesando" when processing fails via an unhandled exception — the catch block doesn't revert deployment status
2. **Bug**: 0-image deployments can be scanned and processed, but processing always fails, and there's no way to re-scan (scan button only shows for "unscanned" status)
3. **UX friction**: The two-step sync → scan flow confuses users — they don't understand why they need to separately scan after syncing

## Root Cause Analysis

### 1. Stuck "Procesando" status (Critical)

In `src/app/camera-trap/actions.ts:282-309`, the catch block for unhandled exceptions marks the job as "failed" but **does NOT revert the deployment status** from "processing" back to "scanned":

```typescript
// actions.ts:282-309 — CURRENT (buggy)
} catch (error) {
  await db.update(processingJobs).set({ status: "failed", ... });
  // ❌ Missing: deployment status revert!
  processNextInQueue();
}
```

Compare to the explicit failure paths (lines 163-185, 204-225, 249-267) which all correctly revert:

```typescript
// actions.ts:175-178 — explicit failure paths do this
await db.update(deployments)
  .set({ status: "scanned", updatedAt: new Date() })
  .where(eq(deployments.id, job.deploymentId));
```

**Impact**: Any unhandled exception during processing leaves the deployment in "processing" forever. The only recovery is a server restart (which triggers `recoverStuckJobs()`).

### 2. 0-image dead end

When a Drive folder has 0 images:
1. `scanDeploymentImages()` sets status → "scanned", `totalImages: 0` (`drive-actions.ts:160-167`)
2. Scan button disappears (only shows for `status === "unscanned"` — `deployment-panel.tsx:190`)
3. User can click "Procesar" → creates job with 0 images → download returns 0 → job fails → deployment reverts to "scanned"
4. Loop: scanned → process → fail → scanned. No way to re-scan to pick up new images.

### 3. No re-scan from UI

`deployment-panel.tsx:190` only shows the scan button when `deployment.status === "unscanned"`. Once scanned, even if new images are added to the Drive folder, there's no UI path to re-scan. The `scanDeploymentImages()` function uses `onConflictDoNothing()`, so re-scanning would be safe and additive.

## Proposed Solution

### Fix A: Revert deployment status in catch block

**File**: `src/app/camera-trap/actions.ts:282-309`

Add deployment status revert to the catch block, matching the explicit failure paths:

```typescript
} catch (error) {
  console.error(`[processJob] Unhandled error:`, error);
  if (tempDir) { try { await cleanupJobTempDir(jobId, tempDir); } catch {} }

  await db.update(processingJobs).set({
    status: "failed",
    errorMessage: error instanceof Error ? error.message : "Procesamiento falló",
    statusMessage: null,
    completedAt: new Date(),
  }).where(eq(processingJobs.id, jobId));

  // ✅ ADD: Revert deployment status (matches explicit failure paths)
  const [failedJob] = await db.select().from(processingJobs).where(eq(processingJobs.id, jobId));
  if (failedJob) {
    await db.update(deployments)
      .set({ status: "scanned", updatedAt: new Date() })
      .where(eq(deployments.id, failedJob.deploymentId));
  }

  processNextInQueue();
}
```

### Fix B: Guard against processing 0-image deployments

**File**: `src/app/camera-trap/actions.ts:50-54`

In `createProcessingJob()`, after querying images, reject if there are none:

```typescript
const deploymentImages = await db.select().from(images)
  .where(eq(images.deploymentId, deploymentId));

// ✅ ADD: Guard against 0-image processing
if (deploymentImages.length === 0) {
  return { success: false, error: "No hay imágenes para procesar. Vuelva a escanear la carpeta." };
}
```

### Fix C: Allow re-scanning from the UI

**File**: `src/app/camera-trap/deployment-panel.tsx:190`

Show a re-scan button for scanned deployments (not just unscanned):

```tsx
// Before: only for unscanned
{deployment.status === "unscanned" && ( <Button>Escanear</Button> )}

// After: for unscanned OR scanned (re-scan to pick up new images)
{(deployment.status === "unscanned" || deployment.status === "scanned") && (
  <Button variant="outline" size="sm" onClick={handleScan} disabled={scanning}>
    {scanning ? <Loader2 ... /> : <ScanSearch ... />}
    {deployment.status === "unscanned" ? "Escanear" : "Re-escanear"}
  </Button>
)}
```

Also update the batch "Escanear Todo" button in `deployments-table.tsx` to optionally include 0-image scanned deployments, or add a separate "Re-escanear vacías" button.

### Fix D: Auto-scan during sync (UX improvement, optional)

Two options for eliminating the manual scan step:

**Option 1: Auto-scan during sync (recommended)**
In `syncWithDrive()` (`drive-actions.ts:22-103`), after inserting new deployments, auto-scan each one. Accept the latency — for most deployments this adds a few seconds per folder.

```typescript
// After inserting new deployment rows:
for (const newDep of newDeployments) {
  await scanDeploymentImages(newDep.id);
}
```

**Pros**: Eliminates the "unscanned" state entirely. One click, done.
**Cons**: Sync takes longer (recursive file listing per folder). Could timeout for many new folders.

**Option 2: Clickable status badge**
Make the "Sin escanear" badge a button that triggers scan when clicked. Add a tooltip: "Haga clic para escanear imágenes".

**Pros**: Keeps sync fast, makes the action discoverable.
**Cons**: Still a manual step, just more obvious.

## Acceptance Criteria

- [x] Processing failures (any code path) always revert deployment status from "processing" to "scanned" — `actions.ts` catch block
- [x] Creating a processing job for a deployment with 0 images returns an error message instead of creating a doomed job
- [x] Users can re-scan deployments that have already been scanned (to pick up new images added to Drive)
- [x] 0-image deployments have a clear path to recovery: re-scan → process
- [x] Existing `recoverStuckJobs()` continues to work as a safety net for server restarts

## Files to Modify

| File | Change |
|---|---|
| `src/app/camera-trap/actions.ts` | Fix A: catch block revert. Fix B: 0-image guard |
| `src/app/camera-trap/deployment-panel.tsx` | Fix C: re-scan button for scanned deployments |
| `src/app/camera-trap/deployments-table.tsx` | Fix C: update batch scan to include re-scan option |
| `src/app/camera-trap/drive-actions.ts` | Fix D (if auto-scan chosen): add scan after sync |
