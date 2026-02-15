---
title: "feat: Replace camera trap sidebar with accordion rows and inline results link"
type: feat
date: 2026-02-14
---

# Replace Camera Trap Sidebar with Accordion Rows + Inline Results Link

## Overview

Redesign the camera trap deployments table to replace the right-side Sheet sidebar with inline expandable/accordion rows that show deployment details below the clicked row. Add a direct "Ver Resultados" button in the table row itself so users can jump to the latest ML results in 1 click instead of 2.

## Problem Statement / Motivation

The current 2-click flow to view ML results is clunky:
1. Click a deployment row to open the sidebar
2. Wait for job data to load, scroll to "Historial de Procesamiento"
3. Click "Ver Resultados" on the latest completed job

Additionally, the sidebar (Sheet) covers part of the table, making it hard to compare deployments. An inline accordion keeps all context visible within the table layout.

## Proposed Solution

### 1. Add a "Resultados" column with a direct link button

Add `lastCompletedJobId` to `DeploymentRow` and the `getDeploymentsWithStats()` query. Display a small button/icon in the table for deployments that have a completed job — clicking it navigates directly to `/camera-trap/results/[jobId]`. **1 click to results.**

### 2. Replace Sheet sidebar with accordion-style expandable rows

Clicking a deployment row (non-checkbox, non-results-button area) toggles an expanded section below that row. The expanded section spans all columns and contains the same content as the current sidebar: metadata grid, Drive link, action buttons (Edit/Scan/Process), and processing job history.

Single-expand behavior (accordion): expanding row B auto-collapses row A. This matches the current one-at-a-time sidebar UX.

## Technical Approach

### Data Layer Changes

**File: `src/app/camera-trap/actions.ts`**

1. Add `lastCompletedJobId: number | null` to the `DeploymentRow` interface (line ~476)
2. Modify `getDeploymentsWithStats()` to also capture the latest *completed* job's ID:
   - Extend the `latestJobStatuses` query (line ~526-544) to also filter for `status = 'completed'` in a separate pass, or adjust the existing query to return the job ID alongside the status
   - Add a `completedJobMap` keyed by deployment ID
   - Populate `lastCompletedJobId` in the return mapping

### Table Changes

**File: `src/app/camera-trap/deployments-table.tsx`**

1. **Add TanStack `getExpandedRowModel()`** to the table config and `expanded` state
2. **Add a "Resultados" column** after "Ultimo Proceso":
   - Shows a small `Eye` or `ArrowRight` icon button when `row.original.lastCompletedJobId` is not null
   - Uses `e.stopPropagation()` to prevent row expansion
   - Wraps a `<Link href={/camera-trap/results/${lastCompletedJobId}}>`
3. **Replace `handleRowClick`** to toggle `row.toggleExpanded()` instead of opening the Sheet
   - Do NOT clear row selection on expand (let selection and expansion be independent)
4. **Render expanded content** below each row:
   - After each `<TableRow>`, check `row.getIsExpanded()`
   - If expanded, render a second `<TableRow>` with a single `<TableCell colSpan={columns.length}>`
   - Inside, render the new `DeploymentExpandedRow` component
5. **Remove the `DeploymentPanel` Sheet** from the JSX and its state (`selectedDeployment`, `panelOpen`)
6. **Collapse on pagination change**: reset `expanded` state in `onPaginationChange`

### New Component: Expanded Row Content

**File: `src/app/camera-trap/deployment-expanded-row.tsx`**

Extracted from `deployment-panel.tsx`, adapted for full-width inline display:

1. **Layout**: 3-section horizontal grid on desktop (`grid-cols-3`), stacked on mobile
   - **Left**: Metadata grid (Proyecto, Sitio, Lat/Lng, Fechas, Imagenes, Fuente) + Drive link
   - **Center**: Action buttons (Editar, Escanear, Procesar) — only shown if `canEdit`
   - **Right**: Processing history (job list with "Ver Resultados" links for completed jobs)
2. **Data loading**: `useEffect` calls `getDeployment(deploymentId)` on mount (same as current sidebar)
   - Cache results in a `Map<number, JobInfo[]>` at the parent level so re-expanding is instant
   - Show loading skeleton during fetch
   - Show error state if fetch fails: "Error al cargar historial"
3. **Edit form**: When editing, the form replaces the metadata section with `max-w-md` constraint
4. **Close button**: Small `X` or `ChevronUp` button in the top-right corner to collapse

### Cleanup

**File: `src/app/camera-trap/deployment-panel.tsx`**

- Delete this file entirely (or keep only if Sheet is used elsewhere — check first)
- Remove `DeploymentPanel` import from `deployments-table.tsx`
- Remove `selectedDeployment` and `panelOpen` state variables

## Acceptance Criteria

- [x] Clicking a deployment row expands an accordion section below it with deployment details
- [x] Clicking the same row again (or a close button, or Escape) collapses it
- [x] Clicking a different row collapses the current and expands the new one (accordion)
- [x] A "Ver Resultados" button/icon appears in the table row for deployments with completed jobs
- [x] Clicking the results button navigates to `/camera-trap/results/[jobId]` in 1 click
- [x] Expanded content shows: metadata grid, Drive link, action buttons (if editor), processing history
- [x] Edit form works within the expanded row
- [x] Scan and Process actions work from the expanded row
- [x] Checkbox multi-select is independent of row expansion (selecting does not collapse, expanding does not clear selection)
- [x] Expanded state resets on pagination change
- [x] Loading state shown while fetching job data for expanded row
- [x] Works responsively — stacked layout on narrow screens
- [x] The old Sheet sidebar (`DeploymentPanel`) is removed

## Dependencies & Risks

- **TanStack React Table expansion**: Well-supported via `getExpandedRowModel()` and `row.getToggleExpandedHandler()`. Low risk.
- **Colspan rendering**: Must render expanded content in a separate `<TableRow>` with `<TableCell colSpan={N}>` — straightforward but outside TanStack's default render loop.
- **No new packages needed**: Radix `Collapsible` is already a dependency if animation is desired, but a simple conditional render also works.
- **Risk**: Table horizontal scroll on mobile means the expanded content also scrolls horizontally. Mitigate by constraining expanded content width to viewport and using a responsive grid.

## References

- Current sidebar: `src/app/camera-trap/deployment-panel.tsx`
- Current table: `src/app/camera-trap/deployments-table.tsx`
- Data query: `src/app/camera-trap/actions.ts:498-571`
- TanStack row expansion docs: https://tanstack.com/table/latest/docs/guide/expanding
- Brainstorm: `docs/brainstorms/2026-02-13-camera-trap-ui-redesign-brainstorm.md` (originally chose sidebar; this plan reverses that decision)
