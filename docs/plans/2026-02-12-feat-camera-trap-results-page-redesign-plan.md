---
title: "feat: Camera Trap Results Page Redesign — Table, Delete, Stats"
type: feat
date: 2026-02-12
depends_on: docs/plans/2026-02-12-feat-camera-trap-ux-polish-and-ml-defaults-plan.md
---

# feat: Camera Trap Results Page Redesign — Table, Delete, Stats

## Overview

Redesign the camera trap results listing page (`/camera-trap/results`) from stacked cards to a compact sortable table, add per-job deletion with cascade cleanup, and add summary stats at the top.

## Problem Statement

The current results page uses full-width cards that are inefficient for scanning multiple jobs. Each card shows limited info (no detections count, no species count, no classifier model). There's no way to delete old/failed jobs, and no aggregate stats to understand the overall state of processing.

## Proposed Solution

1. **Table layout** replacing cards — compact rows with sortable columns
2. **Delete action** with auto-cancel for active jobs, cascade cleanup, and confirmation dialog showing what will be deleted
3. **Summary stat cards** aggregated across all jobs
4. **Client-side sortable columns** for quick data exploration

---

## Changes

### 1. Enrich `getRecentJobs()` with Aggregate Counts

**File**: `src/app/camera-trap/actions.ts`

The current `getRecentJobs()` fetches jobs + deployments. Extend it to also fetch per-job aggregate counts in batch (avoiding N+1).

```ts
// New approach: batch aggregate queries
export async function getRecentJobs(limit: number = 50) {
  await requirePermission("camera-trap", "viewer");

  const jobs = await db.select().from(processingJobs)
    .orderBy(desc(processingJobs.createdAt)).limit(limit);

  if (jobs.length === 0) return [];

  const jobIds = jobs.map(j => j.id);

  // Batch: deployments (existing)
  const deploymentIds = [...new Set(jobs.map(j => j.deploymentId))];
  const deploymentRows = await db.select().from(deployments)
    .where(inArray(deployments.id, deploymentIds));
  const deploymentMap = new Map(deploymentRows.map(d => [d.id, d]));

  // Batch: detection counts per job
  const detectionCounts = await db
    .select({ jobId: detections.jobId, count: count() })
    .from(detections)
    .where(inArray(detections.jobId, jobIds))
    .groupBy(detections.jobId);
  const detCountMap = new Map(detectionCounts.map(r => [r.jobId, r.count]));

  // Batch: species counts per job (distinct species from identifications)
  const speciesCounts = await db
    .select({
      jobId: detections.jobId,
      count: countDistinct(identifications.species)
    })
    .from(identifications)
    .innerJoin(detections, eq(identifications.detectionId, detections.id))
    .where(inArray(detections.jobId, jobIds))
    .groupBy(detections.jobId);
  const specCountMap = new Map(speciesCounts.map(r => [r.jobId, r.count]));

  // Batch: verified identification counts per job (for delete dialog)
  const verifiedCounts = await db
    .select({
      jobId: detections.jobId,
      count: count()
    })
    .from(identifications)
    .innerJoin(detections, eq(identifications.detectionId, detections.id))
    .where(and(
      inArray(detections.jobId, jobIds),
      ne(identifications.verificationStatus, "unverified")
    ))
    .groupBy(detections.jobId);
  const verCountMap = new Map(verifiedCounts.map(r => [r.jobId, r.count]));

  return jobs.map(job => ({
    ...job,
    deployment: deploymentMap.get(job.deploymentId) || null,
    detectionsCount: detCountMap.get(job.id) || 0,
    speciesCount: specCountMap.get(job.id) || 0,
    verifiedCount: verCountMap.get(job.id) || 0,
  }));
}
```

Also add a new function for aggregate stats:

```ts
export async function getResultsStats() {
  await requirePermission("camera-trap", "viewer");

  const [jobStats] = await db
    .select({
      totalJobs: count(),
      totalProcessed: sum(processingJobs.processedImages),
    })
    .from(processingJobs);

  const [detStats] = await db
    .select({ totalDetections: count() })
    .from(detections);

  const [specStats] = await db
    .select({ totalSpecies: countDistinct(identifications.species) })
    .from(identifications);

  return {
    totalJobs: jobStats?.totalJobs || 0,
    totalImagesProcessed: Number(jobStats?.totalProcessed) || 0,
    totalDetections: detStats?.totalDetections || 0,
    uniqueSpecies: specStats?.totalSpecies || 0,
  };
}
```

**Acceptance criteria:**
- [ ] `getRecentJobs()` returns `detectionsCount`, `speciesCount`, `verifiedCount` per job
- [ ] Counts are computed via batch aggregate queries (no N+1)
- [ ] `getResultsStats()` returns page-level aggregate stats
- [ ] Both functions call `requirePermission("camera-trap", "viewer")`

---

### 2. New `deleteJob()` Server Action

**File**: `src/app/camera-trap/actions.ts`

Implements auto-cancel-then-delete in a transaction. Resets image statuses and updates deployment status.

```ts
export async function deleteJob(jobId: number): Promise<ActionResult<void>> {
  const user = await requirePermission("camera-trap", "editor");

  const [job] = await db.select().from(processingJobs)
    .where(eq(processingJobs.id, jobId));
  if (!job) return { success: false, error: "Trabajo no encontrado" };

  // Auto-cancel if active (kill subprocess, clean up temp dir)
  if (job.status === "processing" || job.status === "pending") {
    if (job.pid) {
      try { process.kill(job.pid, "SIGTERM"); } catch {}
    }
    // Clean up temp directory
    const tmpDir = path.join("data/tmp", `ct-job-${jobId}`);
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  await db.transaction(async (tx) => {
    // 1. Delete the job (cascades: detections → identifications)
    await tx.delete(processingJobs).where(eq(processingJobs.id, jobId));

    // 2. Reset images that belonged to this job
    //    (ON DELETE SET NULL already clears jobId, but reset status too)
    await tx.update(images)
      .set({ status: "pending" })
      .where(eq(images.jobId, jobId));
    // NOTE: This must run BEFORE the job delete if SET NULL happens
    // at the DB level. Actually, since we're in a transaction and
    // the SET NULL + this UPDATE both target the same rows,
    // we should reset images FIRST, then delete the job.
    // Re-order: reset images first, then delete job.
  });

  // Actually, let's restructure the transaction properly:
  await db.transaction(async (tx) => {
    // 1. Reset images that belonged to this job (before cascade nulls jobId)
    await tx.update(images)
      .set({ status: "pending", jobId: null })
      .where(eq(images.jobId, jobId));

    // 2. Delete the job (cascades: detections → identifications)
    await tx.delete(processingJobs).where(eq(processingJobs.id, jobId));

    // 3. Check if deployment has any remaining completed jobs
    const remainingJobs = await tx.select({ id: processingJobs.id })
      .from(processingJobs)
      .where(and(
        eq(processingJobs.deploymentId, job.deploymentId),
        eq(processingJobs.status, "completed")
      ));

    // 4. If no completed jobs remain, revert deployment to "scanned"
    if (remainingJobs.length === 0) {
      await tx.update(deployments)
        .set({ status: "scanned" })
        .where(eq(deployments.id, job.deploymentId));
    }
  });

  revalidatePath("/camera-trap/results");
  revalidatePath("/camera-trap");
  return { success: true };
}
```

**Key design decisions:**
- **Auto-cancel**: If job is processing/pending, kill the subprocess via PID and clean up temp dir before deleting
- **Transaction**: Wraps image reset + job delete + deployment status update atomically
- **Image reset**: Sets `status: "pending"` and `jobId: null` before deleting the job row, so the SET NULL cascade doesn't race
- **Deployment status**: Reverts to `"scanned"` only if no other completed jobs remain
- **Return type**: `ActionResult<void>` per project conventions

**Acceptance criteria:**
- [ ] `deleteJob()` requires `"editor"` permission
- [ ] Active jobs (processing/pending) are auto-cancelled (subprocess killed, temp dir cleaned)
- [ ] Deletion is wrapped in a transaction
- [ ] Detections and identifications are cascade-deleted
- [ ] Images get `status: "pending"`, `jobId: null`
- [ ] Deployment status reverts to `"scanned"` if no completed jobs remain
- [ ] Returns `ActionResult<void>`
- [ ] Calls `revalidatePath` for both results and main pages

---

### 3. Redesign Results Page — Table + Stats + Delete

**Files**:
- `src/app/camera-trap/results/page.tsx` — Server Component (data fetching, stats, passes data to client)
- `src/app/camera-trap/results/results-table.tsx` — **New** Client Component (sortable table, delete dialog)

#### Server Component (`page.tsx`)

Fetches enriched jobs + stats, checks user role for delete permission, passes everything to the client table.

```tsx
export default async function ResultsPage() {
  const user = await requirePermission("camera-trap", "viewer");
  const [jobs, stats] = await Promise.all([
    getRecentJobs(50),
    getResultsStats(),
  ]);

  // Check if user can delete (editor or above)
  const canDelete = user.role === "editor" || user.role === "admin";

  return (
    <div className="max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Resultados de Procesamiento</h1>
          <p className="text-sm text-muted-foreground">
            Todos los trabajos de procesamiento y sus resultados.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/camera-trap">Panel</Link>
        </Button>
      </div>

      {/* Summary Stats */}
      <div className="grid gap-4 md:grid-cols-4 mb-6">
        <StatCard label="Trabajos" value={stats.totalJobs} />
        <StatCard label="Imágenes Procesadas" value={stats.totalImagesProcessed} />
        <StatCard label="Detecciones" value={stats.totalDetections} />
        <StatCard label="Especies" value={stats.uniqueSpecies} />
      </div>

      {/* Table or Empty State */}
      {jobs.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <h3 className="text-lg font-medium mb-2">Sin trabajos</h3>
            <p className="text-muted-foreground mb-4">
              Comienza escaneando una carpeta de imágenes de cámaras trampa.
            </p>
            <Button asChild>
              <Link href="/camera-trap">Comenzar</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <ResultsTable jobs={jobs} canDelete={canDelete} />
      )}
    </div>
  );
}
```

#### Client Component (`results-table.tsx`)

Sortable table with delete dialog.

**Table columns:**

| Column | Sortable | Content |
|--------|----------|---------|
| Instalación | Yes | Deployment name |
| Estado | Yes | StatusBadge |
| Imágenes | Yes | `processedImages / totalImages` (failed count in tooltip) |
| Detecciones | Yes | Count |
| Especies | Yes | Count |
| Modelos | No | `detectorModel / classifierModel` (compact) |
| Fecha | Yes (default desc) | `createdAt` formatted |
| Acciones | No | "Ver" link + Delete button (if `canDelete`) |

**Sorting**: Client-side via `useMemo` + `useState` for sort column and direction. Click column header to toggle. Default: `createdAt` descending.

**Delete dialog**: Uses shadcn `Dialog` component (already available at `src/components/ui/dialog.tsx`). Shows:
- Title: "¿Eliminar trabajo #{id}?"
- Body: "Se eliminarán X detecciones y Y identificaciones (Z verificadas). Las imágenes se conservarán pero perderán sus resultados. Esta acción no se puede deshacer."
- Buttons: "Cancelar" (outline) + "Eliminar" (destructive variant)

```tsx
"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import {
  Dialog, DialogContent, DialogFooter,
  DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell,
  TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { deleteJob } from "../actions";

type SortKey = "deployment" | "status" | "images" | "detections"
  | "species" | "date";
type SortDir = "asc" | "desc";

interface Props {
  jobs: Array<{
    id: number;
    status: string;
    totalImages: number;
    processedImages: number;
    failedImages: number;
    detectorModel: string;
    classifierModel: string | null;
    createdAt: Date | null;
    deployment: { id: number; name: string } | null;
    detectionsCount: number;
    speciesCount: number;
    verifiedCount: number;
  }>;
  canDelete: boolean;
}

export function ResultsTable({ jobs, canDelete }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [deleteTarget, setDeleteTarget] = useState<Props["jobs"][number] | null>(null);
  const [deleting, setDeleting] = useState(false);

  const sorted = useMemo(() => {
    return [...jobs].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "deployment":
          cmp = (a.deployment?.name || "").localeCompare(b.deployment?.name || "");
          break;
        case "status":
          cmp = a.status.localeCompare(b.status);
          break;
        case "images":
          cmp = a.processedImages - b.processedImages;
          break;
        case "detections":
          cmp = a.detectionsCount - b.detectionsCount;
          break;
        case "species":
          cmp = a.speciesCount - b.speciesCount;
          break;
        case "date":
          cmp = (a.createdAt?.getTime() || 0) - (b.createdAt?.getTime() || 0);
          break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [jobs, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    const result = await deleteJob(deleteTarget.id);
    setDeleting(false);
    setDeleteTarget(null);
    if (!result.success) {
      alert(result.error);
    }
  }

  const SortHeader = ({ label, col }: { label: string; col: SortKey }) => (
    <TableHead
      className="cursor-pointer select-none hover:bg-muted/50"
      onClick={() => toggleSort(col)}
    >
      {label} {sortKey === col ? (sortDir === "asc" ? "↑" : "↓") : ""}
    </TableHead>
  );

  return (
    <>
      <div className="border rounded-lg overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <SortHeader label="Instalación" col="deployment" />
              <SortHeader label="Estado" col="status" />
              <SortHeader label="Imágenes" col="images" />
              <SortHeader label="Detecciones" col="detections" />
              <SortHeader label="Especies" col="species" />
              <TableHead>Modelos</TableHead>
              <SortHeader label="Fecha" col="date" />
              <TableHead className="text-right">Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map(job => (
              <TableRow key={job.id}>
                <TableCell className="font-medium">
                  {job.deployment?.name || "Instalación desconocida"}
                </TableCell>
                <TableCell>
                  <StatusBadge status={job.status} type="job" />
                </TableCell>
                <TableCell>
                  {job.processedImages}/{job.totalImages}
                  {job.failedImages > 0 && (
                    <span className="text-destructive text-xs ml-1">
                      ({job.failedImages} fallidas)
                    </span>
                  )}
                </TableCell>
                <TableCell>{job.detectionsCount}</TableCell>
                <TableCell>{job.speciesCount}</TableCell>
                <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                  {job.detectorModel}
                  {job.classifierModel && ` / ${job.classifierModel}`}
                </TableCell>
                <TableCell className="text-sm">
                  {job.createdAt?.toLocaleDateString() || "—"}
                </TableCell>
                <TableCell className="text-right space-x-1">
                  <Button asChild size="sm" variant="ghost">
                    <Link href={`/camera-trap/results/${job.id}`}>Ver</Link>
                  </Button>
                  {canDelete && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setDeleteTarget(job)}
                    >
                      Eliminar
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              ¿Eliminar trabajo #{deleteTarget?.id}?
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Se eliminarán <strong>{deleteTarget?.detectionsCount} detecciones</strong> y
            sus identificaciones
            {(deleteTarget?.verifiedCount || 0) > 0 && (
              <> (<strong>{deleteTarget?.verifiedCount} verificadas</strong>)</>
            )}.
            Las imágenes se conservarán pero perderán sus resultados.
          </p>
          <p className="text-sm text-destructive font-medium">
            Esta acción no se puede deshacer.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? "Eliminando..." : "Eliminar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
```

**Wireframe:**

```
┌──────────────────────────────────────────────────────────────────────┐
│ Resultados de Procesamiento                              [Panel]     │
│ Todos los trabajos de procesamiento y sus resultados.                │
│                                                                      │
│ ┌──────────┐ ┌──────────────────┐ ┌─────────────┐ ┌──────────┐     │
│ │ Trabajos  │ │ Imgs Procesadas  │ │ Detecciones │ │ Especies │     │
│ │    12     │ │     5,432        │ │   3,210     │ │    24    │     │
│ └──────────┘ └──────────────────┘ └─────────────┘ └──────────┘     │
│                                                                      │
│ ┌────────────────────────────────────────────────────────────────┐   │
│ │ Instalación↓ │ Estado │ Imágenes │ Det. │ Esp. │ Modelos│Fecha│   │
│ ├──────────────┼────────┼──────────┼──────┼──────┼────────┼─────┤   │
│ │ Sitio1       │✅ Done │ 456/456  │  312 │   12 │ MDV6/… │02/12│   │
│ │ Sitio2       │⏳ Proc │ 150/500  │   98 │    5 │ MDV6/… │02/11│   │
│ │ Sitio3       │❌ Fail │ 12/189   │    0 │    0 │ MDV6/… │02/10│   │
│ └────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

**Acceptance criteria:**
- [ ] Results page shows a sortable table instead of cards
- [ ] Table shows: deployment name, status, images (processed/total + failed), detections count, species count, models, date
- [ ] Columns are client-side sortable (click header to toggle asc/desc)
- [ ] Default sort: date descending
- [ ] Summary stats at top: total jobs, images processed, detections, species
- [ ] Delete button visible only for editors+
- [ ] Delete confirmation dialog shows cascade counts (detections, verified identifications)
- [ ] Delete calls `deleteJob()` server action
- [ ] Page revalidates after deletion
- [ ] Empty state preserved when no jobs exist
- [ ] Table handles overflow properly (min-w-0, overflow-x-hidden per documented pattern)

---

### 4. Ensure Table UI Component Exists

**File**: Check if `src/components/ui/table.tsx` exists. If not, add it via shadcn.

```bash
# If table component doesn't exist:
npx shadcn@latest add table
```

The shadcn Table component provides `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell` — all used in `ResultsTable`.

**Acceptance criteria:**
- [ ] shadcn Table component available at `src/components/ui/table.tsx`

---

## Implementation Phases

### Phase 1: Data Layer (actions.ts)
- [x] Extend `getRecentJobs()` with batch aggregate queries for detections, species, verified counts
- [x] Add `getResultsStats()` function
- [x] Add `deleteJob()` server action with auto-cancel, transaction, image reset, deployment status update
- [x] `npm run build` passes

### Phase 2: UI Components
- [x] Add shadcn Table component if missing
- [x] Create `src/app/camera-trap/results/results-table.tsx` Client Component
- [x] Implement sortable columns with `useMemo`/`useState`
- [x] Implement delete confirmation Dialog with cascade counts

### Phase 3: Page Integration
- [x] Rewrite `src/app/camera-trap/results/page.tsx` to use stats + table
- [x] Pass `canDelete` prop based on user role
- [ ] Verify overflow CSS (min-w-0, overflow-x-hidden) per institutional learnings
- [ ] Test empty state, single job, multiple jobs
- [ ] Test delete flow: completed job, failed job, processing job (auto-cancel)
- [x] `npm run build` passes

---

## Edge Cases & Gotchas

- **Active job deletion**: Auto-cancels subprocess via SIGTERM, cleans temp dir, then deletes in transaction
- **Deployment status**: Reverts to `"scanned"` only when NO completed jobs remain for that deployment
- **Image status**: Reset to `"pending"` so images appear ready for reprocessing
- **Table overflow**: Apply `min-w-0` on flex parents and `overflow-x-hidden` on main (per documented CSS fix)
- **Verified data loss**: Dialog explicitly warns about verified identification count
- **Date serialization**: Server Component passes Date objects → Client Component receives them. May need `.toISOString()` serialization if Next.js strips Date objects in props.
- **`classifierModel` may be null**: Current hardcoded ML defaults set it, but older jobs may not have it. Handle with conditional display.

## References

### Internal References
- Results page: `src/app/camera-trap/results/page.tsx`
- Results detail: `src/app/camera-trap/results/[id]/page.tsx`
- Server actions: `src/app/camera-trap/actions.ts`
- Schema: `src/db/schema.ts` (processingJobs, detections, identifications, images)
- Admin delete pattern: `src/app/admin/admin-client.tsx:110` (uses `window.confirm()`)
- Dialog pattern: `src/app/finance/cashflow/projections-table.tsx` (shadcn Dialog for delete)
- Cancel job: `src/app/camera-trap/actions.ts` (`cancelJob()` function)
- Table overflow fix: `docs/solutions/ui-bugs/biochoco-overview-horizontal-scroll-map-overlap.md`

### Institutional Learnings
- Server actions MUST use `requirePermission()` (not just `getCurrentUser()`)
- Destructive operations: write-then-delete pattern (reset images BEFORE deleting job)
- All bulk operations use transactions (CLAUDE.md convention)
- `ActionResult<T>` discriminated union for all action return types
- Table CSS: `min-w-0` on flex parents + `overflow-y-auto overflow-x-hidden` on main
