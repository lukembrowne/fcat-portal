---
title: "feat: Improve camera trap deployments table columns"
type: feat
date: 2026-02-14
---

# Improve Camera Trap Deployments Table Columns

## Overview

Restructure the deployments table to show more actionable data at a glance. Remove GPS coordinates (visible in expanded row), add detection and species count columns from the latest completed job, and add an always-visible status legend explaining what each deployment status means.

## Changes

### 1. Remove "Ubicación" column (`deployments-table.tsx`)

Delete the `location` column definition (currently shows `latitude, longitude` to 4 decimal places). GPS coordinates remain visible in the expanded row's metadata grid.

### 2. Add "Detecciones" and "Especies" columns (`deployments-table.tsx`)

Two new numeric columns after "Imágenes":

| Column | Header | Source | Display |
|--------|--------|--------|---------|
| `totalDetections` | Detecciones | Count of detections from the latest completed job | `toLocaleString()` if > 0, "—" if no completed job exists, "0" if completed but no detections |
| `distinctSpecies` | Especies | Count of distinct species from the latest completed job | Same display logic |

Both columns: `tabular-nums`, sortable, `enableGlobalFilter: false`.

**Data source**: Latest completed job only (via `lastCompletedJobId`). This avoids double-counting when a deployment is re-processed with different models and matches the existing "Resultados" link behavior.

### 3. Extend `DeploymentRow` and `getDeploymentsWithStats()` (`actions.ts`)

Add two fields to `DeploymentRow`:

```typescript
totalDetections: number | null;  // null = no completed job
distinctSpecies: number | null;  // null = no completed job
```

Add two batch queries to `getDeploymentsWithStats()`, adapted from the existing pattern in `getRecentJobs()` (lines 1007–1025):

```
// Batch: detection counts per latest completed job
// Filter: detections.jobId IN completedJobIds
// Group by: processingJobs.deploymentId

// Batch: distinct species counts per latest completed job
// Join: identifications → detections
// Filter: detections.jobId IN completedJobIds
// Group by: processingJobs.deploymentId
```

Use the already-computed `completedJobMap` (Map<deploymentId, jobId>) to get the job IDs to query against. This avoids N+1 queries.

### 4. Add status legend (`deployments-table.tsx`)

An always-visible section below the toolbar showing all 5 deployment statuses with their colored badges and a one-line Spanish description:

```
[Badge] Sin escanear — Carpeta importada de Drive, imágenes aún no buscadas
[Badge] Escaneada — Imágenes encontradas y contadas, lista para procesar
[Badge] Procesando — El modelo ML está analizando las imágenes
[Badge] Procesada — Análisis ML completado, resultados disponibles
[Badge] Verificada — Identificaciones revisadas por un investigador
```

Render using the existing `<StatusBadge>` component inline. Keep it compact — a single row with `flex-wrap` or a small grid. Subtle styling (`text-xs text-muted-foreground bg-muted/30 rounded-md px-3 py-2`).

## Column Layout After Changes

| # | Column | Width | Notes |
|---|--------|-------|-------|
| 1 | Select (checkbox) | Narrow | Only for editors |
| 2 | Nombre | Flexible | Main identifier |
| 3 | Proyecto | Medium | |
| 4 | Sitio | Medium | |
| 5 | Estado | Narrow | Badge |
| 6 | Imágenes | Narrow | Numeric |
| 7 | **Detecciones** | Narrow | NEW — numeric |
| 8 | **Especies** | Narrow | NEW — numeric |
| 9 | Último Proceso | Medium | Date |
| 10 | Resultados | Narrow | Link |
| 11 | Fechas | Medium | Date range |
| 12 | Expand chevron | Narrow | |

Net: removed 1 wide column (Ubicación), added 2 narrow numeric columns. Overall table should be slightly narrower.

## Files to Modify

| File | Change |
|------|--------|
| `src/app/camera-trap/actions.ts` | Add `totalDetections`, `distinctSpecies` to `DeploymentRow`. Add batch queries in `getDeploymentsWithStats()`. |
| `src/app/camera-trap/deployments-table.tsx` | Remove `location` column. Add `totalDetections` and `distinctSpecies` column definitions. Add status legend section. |

## Edge Cases

- **No completed job**: `totalDetections` and `distinctSpecies` are `null` → display "—"
- **Completed job with 0 detections**: Display "0" (meaningful — camera may be misplaced)
- **Re-processing (status=processing with prior completed job)**: Show counts from prior completed job. Resultados link still works.
- **Large counts (10,000+ detections)**: Use `toLocaleString()` for formatting

## Verification

1. `npx tsc --noEmit` — no new type errors
2. Table shows Detecciones and Especies columns with correct data
3. GPS coordinates column is gone from table, still visible in expanded row
4. Status legend is always visible below the toolbar
5. Sorting works on new columns
6. "—" shown for unprocessed deployments, "0" shown for processed-but-empty
