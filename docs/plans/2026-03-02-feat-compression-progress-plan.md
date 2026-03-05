# Compression Progress Feedback Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show real-time compression progress in the existing FloatingJobProgress toast with per-batch Docker logging.

**Architecture:** Add a `job_type` column to `processingJobs` table (`'ml' | 'compression'`). Refactor `compressDeploymentImages` into a thin enqueue action + fire-and-forget background worker that updates `processedImages` and `statusMessage` per batch. The existing active-jobs API, SSE endpoint, and FloatingJobProgress toast already work with any row in the jobs table — they just need `jobType` passed through so the toast can hide irrelevant links.

**Tech Stack:** Next.js server actions, Drizzle ORM, SQLite, SSE, React client components

---

### Task 1: Add `jobType` column to schema

**Files:**
- Modify: `src/db/schema.ts:184-209` (processingJobs table)
- Modify: `scripts/push-schema.mjs:75-91` (CREATE TABLE DDL)
- Modify: `scripts/push-schema.mjs:454+` (migrations array)
- Modify: `tests/helpers/test-db.ts:111-128` (test DDL)

**Step 1: Add column to Drizzle schema**

In `src/db/schema.ts`, add after the `status` field (line ~196):

```typescript
  jobType: text("job_type").notNull().default("ml"),
```

**Step 2: Add column to push-schema CREATE TABLE**

In `scripts/push-schema.mjs`, inside the `biochoco_processing_jobs` CREATE TABLE statement, add after the `status` line:

```sql
    job_type TEXT NOT NULL DEFAULT 'ml',
```

**Step 3: Add ALTER TABLE migration**

In `scripts/push-schema.mjs`, add to the `migrations` array:

```javascript
  `ALTER TABLE biochoco_processing_jobs ADD COLUMN job_type TEXT NOT NULL DEFAULT 'ml'`,
```

**Step 4: Add column to test DDL**

In `tests/helpers/test-db.ts`, inside the `biochoco_processing_jobs` CREATE TABLE, add after the `status` line:

```sql
    job_type TEXT NOT NULL DEFAULT 'ml',
```

**Step 5: Run tests to verify schema change is compatible**

Run: `npm run test:run`
Expected: All 401 tests pass (no behavior changes yet)

**Step 6: Commit**

```
feat(camera-trap): add jobType column to processingJobs schema
```

---

### Task 2: Include `jobType` in active-jobs API response

**Files:**
- Modify: `src/app/api/active-jobs/route.ts:30-39`
- Modify: `src/hooks/use-active-jobs.ts:5-14` (ActiveJob interface)

**Step 1: Add jobType to API response**

In `src/app/api/active-jobs/route.ts`, add `jobType` to the result map (line ~30):

```typescript
  const result = activeJobs.map((job) => ({
    jobId: job.id,
    deploymentId: job.deploymentId,
    deploymentName: deploymentMap.get(job.deploymentId) || "Desconocida",
    status: job.status,
    jobType: job.jobType,
    totalImages: job.totalImages,
    processedImages: job.processedImages,
    statusMessage: job.statusMessage,
    startedAt: job.startedAt?.toISOString() ?? null,
  }));
```

**Step 2: Add jobType to ActiveJob interface**

In `src/hooks/use-active-jobs.ts`, add to the `ActiveJob` interface:

```typescript
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
```

**Step 3: Commit**

```
feat(camera-trap): include jobType in active-jobs API and hook
```

---

### Task 3: Update FloatingJobProgress toast for compression jobs

**Files:**
- Modify: `src/components/floating-job-progress.tsx`

**Step 1: Pass jobType through from activeJob**

The `activeJob` already comes from `useActiveJobs` which now includes `jobType`. Add it to the derived variables section (around line ~155):

```typescript
  const jobType = activeJob?.jobType ?? "ml";
  const isCompression = jobType === "compression";
```

**Step 2: Update header subtitle**

Replace the header subtitle (lines ~248-252) to show "Compresión" instead of "Trabajo #N" for compression jobs:

```typescript
          <p className="text-xs text-muted-foreground">
            {hasQueue
              ? `Procesando ${currentQueuePosition} de ${totalQueueSize}`
              : isCompression
                ? "Compresión de imágenes"
                : `Trabajo #${jobId}`}
          </p>
```

Also update the minimized pill (line ~232-235):

```typescript
          <span>
            {hasQueue
              ? `Procesando ${currentQueuePosition} de ${totalQueueSize}`
              : isCompression
                ? "Comprimiendo..."
                : `Trabajo #${jobId}`}
          </span>
```

**Step 3: Hide ML-specific links for compression jobs**

In the actions section (lines ~338-377), wrap the "Ver detalles" link and results links so they don't show for compression:

```typescript
        <div className="flex items-center gap-2">
          {!isTerminal && (
            <>
              {!isCompression && (
                <Link
                  href={`/camera-trap/process?jobId=${jobId}`}
                  className="text-xs text-primary hover:underline"
                >
                  Ver detalles
                </Link>
              )}
              {!isCompression && <span className="text-muted-foreground">·</span>}
              <button
                onClick={handleCancel}
                disabled={cancelling}
                className="text-xs text-red-600 hover:underline disabled:opacity-50"
              >
                {cancelling
                  ? "Cancelando..."
                  : hasQueue
                    ? "Cancelar Cola"
                    : "Cancelar"}
              </button>
            </>
          )}
          {status === "completed" && !isCompression && (
            <Link
              href={`/camera-trap/results/${jobId}`}
              className="text-xs font-medium text-green-600 hover:underline"
            >
              Ver resultados
            </Link>
          )}
          {status === "completed" && isCompression && (
            <span className="text-xs font-medium text-green-600">
              Compresión completada
            </span>
          )}
          {(status === "failed" || status === "cancelled") && !isCompression && (
            <Link
              href={`/camera-trap/process?jobId=${jobId}`}
              className="text-xs text-muted-foreground hover:underline"
            >
              Ver detalles
            </Link>
          )}
          {(status === "failed" || status === "cancelled") && isCompression && (
            <span className="text-xs text-muted-foreground">
              {status === "failed" ? "Compresión fallida" : "Compresión cancelada"}
            </span>
          )}
        </div>
```

**Step 4: Commit**

```
feat(camera-trap): update FloatingJobProgress to handle compression jobs
```

---

### Task 4: Refactor compressDeploymentImages into enqueue + background worker

**Files:**
- Modify: `src/app/camera-trap/drive-actions.ts:292-448`

This is the main task. The current `compressDeploymentImages` function becomes two functions:

1. `compressDeploymentImages` — thin enqueue (exported server action)
2. `compressJobInternal` — background worker (internal, not exported)

**Step 1: Rewrite compressDeploymentImages as enqueue action**

Replace the current function (lines 303-448) with:

```typescript
export async function compressDeploymentImages(
  deploymentId: number,
): Promise<ActionResult<{ jobId: number }>> {
  const user = await requirePermission("camera-trap", "admin");

  try {
    await requireDeploymentAccess(user, deploymentId);

    const [deployment] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deploymentId));

    if (!deployment) {
      return { success: false, error: "Instalación no encontrada" };
    }

    // Guard: don't compress during active ML processing
    if (deployment.status === "processing") {
      return { success: false, error: "No se puede comprimir mientras se está procesando" };
    }

    // Check for an already-active compression job on this deployment
    const [existingJob] = await db
      .select()
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.deploymentId, deploymentId),
          eq(processingJobs.jobType, "compression"),
          inArray(processingJobs.status, ["pending", "processing"]),
        ),
      );

    if (existingJob) {
      return { success: false, error: "Ya hay una compresión en curso para esta instalación" };
    }

    // Count uncompressed JPEG images
    const uncompressedImages = await db
      .select()
      .from(images)
      .where(
        and(
          eq(images.deploymentId, deploymentId),
          eq(images.compressed, false),
          sql`${images.driveFileId} IS NOT NULL`,
        ),
      );

    const jpegCount = uncompressedImages.filter((img) => {
      const ext = path.extname(img.filename).toLowerCase();
      return JPEG_EXTENSIONS.has(ext);
    }).length;

    if (jpegCount === 0) {
      return { success: false, error: "No hay imágenes para comprimir" };
    }

    // Create compression job
    const [job] = await db
      .insert(processingJobs)
      .values({
        deploymentId,
        jobType: "compression",
        status: "pending",
        totalImages: jpegCount,
        processedImages: 0,
        failedImages: 0,
        createdBy: user.email,
        statusMessage: "Preparando compresión...",
      })
      .returning();

    // Fire and forget
    compressJobInternal(job.id, deploymentId, user.email);

    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: { jobId: job.id } };
  } catch (err) {
    console.error("[compress] Enqueue failed:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : "Error al iniciar compresión",
    };
  }
}
```

**Step 2: Add the background worker function**

Add below the enqueue function. Note: this needs `processingJobs` imported from schema (already imported in actions.ts but needs adding to drive-actions.ts imports).

```typescript
async function compressJobInternal(
  jobId: number,
  deploymentId: number,
  userEmail: string,
): Promise<void> {
  const startTime = Date.now();

  try {
    // Mark as processing
    await db
      .update(processingJobs)
      .set({
        status: "processing",
        startedAt: new Date(),
        statusMessage: "Comprimiendo imágenes...",
      })
      .where(eq(processingJobs.id, jobId));

    // Get uncompressed JPEG images
    const uncompressedImages = await db
      .select()
      .from(images)
      .where(
        and(
          eq(images.deploymentId, deploymentId),
          eq(images.compressed, false),
          sql`${images.driveFileId} IS NOT NULL`,
        ),
      );

    const jpegImages = uncompressedImages.filter((img) => {
      const ext = path.extname(img.filename).toLowerCase();
      return JPEG_EXTENSIONS.has(ext);
    });

    const skipped = uncompressedImages.length - jpegImages.length;
    let compressed = 0;
    let failed = 0;
    let savedBytes = 0;
    const totalBatches = Math.ceil(jpegImages.length / COMPRESSION_BATCH_SIZE);

    console.log(`[compress] Deployment ${deploymentId}: starting — ${jpegImages.length} images to compress`);

    for (let i = 0; i < jpegImages.length; i += COMPRESSION_BATCH_SIZE) {
      const batchNum = Math.floor(i / COMPRESSION_BATCH_SIZE) + 1;
      const batch = jpegImages.slice(i, i + COMPRESSION_BATCH_SIZE);

      // Check if job was cancelled
      const [currentJob] = await db
        .select({ status: processingJobs.status })
        .from(processingJobs)
        .where(eq(processingJobs.id, jobId));

      if (currentJob?.status === "cancelled") {
        console.log(`[compress] Deployment ${deploymentId}: cancelled by user`);
        return;
      }

      const results = await Promise.allSettled(
        batch.map(async (img) => {
          const sharp = (await import("sharp")).default;

          let originalBuffer: Buffer;
          const cachePath = img.path || path.join(CACHE_BASE, String(deploymentId), img.filename);

          try {
            originalBuffer = await fs.readFile(cachePath);
          } catch {
            originalBuffer = await downloadFileToBuffer(img.driveFileId!);
          }

          const originalSize = originalBuffer.length;

          const compressedBuffer = await sharp(originalBuffer)
            .jpeg({ quality: COMPRESSION_QUALITY })
            .toBuffer();

          const newSize = compressedBuffer.length;

          if (newSize >= originalSize) {
            await db
              .update(images)
              .set({ compressed: true })
              .where(eq(images.id, img.id));
            return { saved: 0 };
          }

          await updateFileContent(img.driveFileId!, compressedBuffer, "image/jpeg");

          try {
            await fs.mkdir(path.dirname(cachePath), { recursive: true });
            await fs.writeFile(cachePath, compressedBuffer);
          } catch {
            // Cache update is best-effort
          }

          const thumbPath = path.join(THUMBNAIL_DIR, String(deploymentId), `${img.id}.jpg`);
          try {
            await fs.unlink(thumbPath);
          } catch {
            // Thumbnail may not exist
          }

          await db
            .update(images)
            .set({ compressed: true, fileSize: newSize })
            .where(eq(images.id, img.id));

          return { saved: originalSize - newSize };
        }),
      );

      for (const result of results) {
        if (result.status === "fulfilled") {
          compressed++;
          savedBytes += result.value.saved;
        } else {
          console.error("[compress] Image failed:", result.reason);
          failed++;
        }
      }

      const processedSoFar = compressed + failed;
      const savedMB = (savedBytes / (1024 * 1024)).toFixed(1);

      // Update job progress
      await db
        .update(processingJobs)
        .set({
          processedImages: processedSoFar,
          failedImages: failed,
          statusMessage: `Comprimiendo... ${processedSoFar} de ${jpegImages.length}`,
        })
        .where(eq(processingJobs.id, jobId));

      console.log(
        `[compress] Deployment ${deploymentId}: batch ${batchNum}/${totalBatches} — ${processedSoFar}/${jpegImages.length} images, ${savedMB} MB saved so far`
      );
    }

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(0);
    const totalSavedMB = (savedBytes / (1024 * 1024)).toFixed(1);

    // Mark completed
    await db
      .update(processingJobs)
      .set({
        status: "completed",
        completedAt: new Date(),
        processedImages: compressed + failed,
        failedImages: failed,
        statusMessage: `Comprimidas: ${compressed}, Omitidas: ${skipped}, Errores: ${failed}, Ahorro: ${totalSavedMB} MB`,
      })
      .where(eq(processingJobs.id, jobId));

    // Activity log
    await db.insert(activityLog).values({
      userEmail,
      action: "compress_images",
      projectId: "camera-trap",
      targetType: "deployment",
      targetId: String(deploymentId),
      details: JSON.stringify({ compressed, skipped, failed, savedBytes }),
    });

    console.log(
      `[compress] Deployment ${deploymentId}: complete — ${compressed} compressed, ${skipped} skipped, ${failed} failed, ${totalSavedMB} MB saved (${elapsedSec}s)`
    );

    revalidatePath(CAMERA_TRAP_PATH);
  } catch (err) {
    console.error(`[compress] Deployment ${deploymentId}: FAILED —`, err);

    await db
      .update(processingJobs)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorMessage: err instanceof Error ? err.message : "Error desconocido",
        statusMessage: "Error en compresión",
      })
      .where(eq(processingJobs.id, jobId));

    revalidatePath(CAMERA_TRAP_PATH);
  }
}
```

**Step 3: Add `processingJobs` to the imports at top of drive-actions.ts**

In `src/app/camera-trap/drive-actions.ts` line 4, add `processingJobs` to the schema import:

```typescript
import { deployments, images, videos, cameraTrapProjects, activityLog, processingJobs } from "@/db/schema";
```

Also add `inArray` to the drizzle-orm import if not already there (line 5).

**Step 4: Run tests**

Run: `npm run test:run`
Expected: All tests pass

**Step 5: Commit**

```
feat(camera-trap): refactor compression into background job with progress tracking
```

---

### Task 5: Update expanded row button to enqueue and dispatch event

**Files:**
- Modify: `src/app/camera-trap/deployment-expanded-row.tsx`

**Step 1: Update handleCompress to dispatch job-started event**

Replace the existing `handleCompress` function and related state. Remove `compressionResult` state — the toast now handles feedback.

Remove these state declarations (lines ~78-79):
```typescript
  // REMOVE:
  const [compressing, startCompressing] = useTransition();
  const [compressionResult, setCompressionResult] = useState<string | null>(null);
```

Replace with:
```typescript
  const [compressing, startCompressing] = useTransition();
```

Replace the `handleCompress` function (lines ~192-207):

```typescript
  const handleCompress = () => {
    startCompressing(async () => {
      const result = await compressDeploymentImages(deployment.id);
      if (result.success) {
        window.dispatchEvent(new Event("job-started"));
        router.refresh();
      } else {
        // Show error inline since job wasn't created
        alert(result.error);
      }
    });
  };
```

**Step 2: Simplify the button area**

Remove the `compressionResult` display span (lines ~500-504). The button stays the same but the result text is gone — the toast handles it now.

Remove:
```typescript
              {compressionResult && (
                <span className={`text-xs ${compressionResult.startsWith("Error") ? "text-destructive" : "text-green-600"}`}>
                  {compressionResult}
                </span>
              )}
```

**Step 3: Run tests and verify build**

Run: `npm run test:run`
Run: `npm run build`
Expected: Both pass

**Step 4: Commit**

```
feat(camera-trap): update compress button to use background job with toast feedback
```

---

### Task 6: Include jobType in SSE progress endpoint

**Files:**
- Modify: `src/app/api/progress/route.ts:60-68`

**Step 1: Add jobType to SSE event payload**

In `src/app/api/progress/route.ts`, update the `sendEvent` call (line ~60):

```typescript
          sendEvent({
            jobId: job.id,
            status: job.status,
            processed: job.processedImages,
            total: job.totalImages,
            failed: job.failedImages,
            statusMessage: job.statusMessage,
            jobType: job.jobType,
            startedAt: job.startedAt?.toISOString() ?? null,
          });
```

**Step 2: Update FloatingJobProgress SSE handler to use jobType from SSE**

In `src/components/floating-job-progress.tsx`, update the `SSEData` interface (lines ~11-18):

```typescript
interface SSEData {
  jobId: number;
  status: string;
  processed: number;
  total: number;
  failed: number;
  statusMessage?: string;
  jobType?: string;
  startedAt?: string | null;
}
```

Then update the `jobType` / `isCompression` derivation to prefer SSE data:

```typescript
  const jobType = sseData?.jobType ?? activeJob?.jobType ?? "ml";
  const isCompression = jobType === "compression";
```

**Step 3: Commit**

```
feat(camera-trap): include jobType in SSE progress events
```

---

### Task 7: Final verification

**Step 1: Run full test suite**

Run: `npm run test:run`
Expected: All tests pass

**Step 2: Run build**

Run: `npm run build`
Expected: Clean build, no errors

**Step 3: Manual smoke test plan**

1. Start dev server: `npm run dev`
2. Go to `/camera-trap`, expand a deployment with images
3. Click "Comprimir Imágenes"
4. Verify: button returns quickly, toast appears bottom-right with "Compresión de imágenes"
5. Verify: progress bar updates, status shows "Comprimiendo... X de Y"
6. Navigate away from the page — verify toast persists
7. Check Docker logs for `[compress]` batch messages
8. Verify: on completion, toast shows summary and auto-dismisses after 8s
9. Verify: no "Ver detalles" or "Ver resultados" links on compression toast

**Step 4: Commit any final fixes, then done**
