---
title: Camera Trap Module Redesign
type: feat
date: 2026-04-03
---

# Camera Trap Module Redesign

## Overview

Redesign the camera trap module to support 100+ deployments across multiple projects. Replace the flat table with project-grouped rows, remove expandable rows in favor of click-through to the detail page, simplify status labels, and add summary cards.

Brainstorm: `docs/brainstorms/2026-04-03-camera-trap-module-redesign-brainstorm.md`

## Problem Statement

1. **Flat table doesn't scale** — 100+ deployments with no grouping makes it hard to find what needs attention
2. **Scanning vs. processing is confusing** — users see "unscanned" and "scanned" as separate stages but scanning is just a technical prerequisite
3. **Expandable rows compete with detail page** — metadata and actions live in both places, creating an awkward middle ground

> Nightly Drive auto-sync is a separate concern and will be its own plan.

## Proposed Solution

### Phase A: Grouped Table + Status Simplification

This is the core change. One phase, shipped together.

#### 1. Simplified status labels (display-only, no DB changes)

| DB Status | User-Facing Label | Badge Color |
|-----------|-------------------|-------------|
| `unscanned` | Por Procesar | blue |
| `scanned` | Por Procesar | blue |
| `processing` | Procesando... | yellow/animated |
| `processed` (detections > 0) | Por Revisar | orange |
| `processed` (detections = 0) | Sin Detecciones | gray |
| `verified` | Verificada | green |
| `verified_empty` | Vacía (verificada) | green |

> `unscanned` and `scanned` both display as "Por Procesar" — the distinction is invisible to users. `processed` with zero detections gets a distinct label to avoid a false "review needed" signal (per Kieran's review).

**File:** `src/components/status-badge.tsx` — update the label mapping (~10 lines).

#### 2. Summary cards (server-rendered)

Four static count cards at the top of `/camera-trap`:

- **Por Procesar** — count of `unscanned` + `scanned`
- **Procesando** — count of `processing`
- **Por Revisar** — count of `processed`
- **Verificadas** — count of `verified` + `verified_empty`

Counts computed in the server component from the existing `getDeploymentsWithStats` result — no new queries. Cards are simple numbers, no click-to-scroll behavior. Filtered by user's project access.

**File:** `src/app/camera-trap/page.tsx` — add cards section above table.

#### 3. One-level project grouping

Group deployments by project only (not project → status). Use the existing status filter dropdown for cross-cutting status views. This gives two orthogonal navigation axes without nested group complexity.

- **Collapsible project sections** — e.g., "BioChoco (45 · 12 por procesar)" / "Canandé (32 · 5 por revisar)"
- **Default state:** All groups collapsed, showing project name + total count + actionable count
- **Keep the existing status filter** — when applied, empty groups are hidden

**Implementation:** Group data server-side in `page.tsx` and pass a `{ project: string, deployments: DeploymentRow[] }[]` structure to the table component. The server already fetches all deployments — group them there, not in `useMemo`. The client component handles collapse/expand state and renders group headers as styled rows.

**TanStack Table:** Remove `getExpandedRowModel` and the expand column. Keep TanStack for sorting within groups and row selection. The grouping is structural (server-provided), not a TanStack feature. If this simplification makes TanStack feel like dead weight, we can evaluate replacing it with plain `Array.sort()` + `Array.filter()` — but that's a follow-up, not a blocker.

#### 4. Click-through rows, remove expandable rows

- Row click → `router.push(\`/camera-trap/${id}\`)`
- Delete `deployment-expanded-row.tsx` (~414 lines removed)
- **Keep a minimal actions dropdown** on each row (Process, View Results, Delete) so users don't have to navigate to the detail page for every action

#### 5. Filtering and selection

- Keep global text search — matches within expanded groups
- Keep status filter dropdown — orthogonal to project grouping
- Keep existing checkbox selection and batch toolbar (process, edit, delete, export)
- No group-level select-all checkboxes (add later if requested)

**Files to modify:**
- `src/app/camera-trap/page.tsx` — summary cards, server-side grouping
- `src/app/camera-trap/deployments-table.tsx` — remove expansion, add group rendering, click-through rows
- `src/components/status-badge.tsx` — label mapping

**Files to delete:**
- `src/app/camera-trap/deployment-expanded-row.tsx`

### Phase B: Detail Page Enhancement

Prepare the detail page to be the single source of truth, absorbing content from the removed expanded row.

#### 1. Status banner with CTA

A server component at the top of the detail page showing current status + one clear action button. Only the process dialog trigger needs client interactivity — everything else is a link or server action.

| Status | CTA Text | CTA Action |
|--------|----------|------------|
| `unscanned` / `scanned` | Procesar | Open process dialog |
| `processing` | Procesando... (Ver progreso) | Link to `/camera-trap/process?jobId=X` |
| `processed` (detections > 0) | Revisar N Detecciones | Link to `/camera-trap/results/[lastCompletedJobId]` |
| `processed` (detections = 0) | Verificar (Sin Detecciones) | Call `markVerifiedEmpty` |
| `verified` | Ver Resultados | Link to latest results |
| `verified_empty` | Vacía Verificada | No primary action |

For viewers: status text only, no action buttons.

> The CTA logic is a pure function of `(status, detectionCount, lastCompletedJobId, userRole)` — extract it and unit test it.

> **Edge case**: `processing` status needs the active job ID for the progress link. Add `lastJobId` (any status, not just completed) to the deployment query, or resolve from the most recent job in the processing history.

#### 2. Content migration from expanded row

Complete checklist of everything in `deployment-expanded-row.tsx` and its new home:

| Content | Current Location | New Location |
|---------|-----------------|--------------|
| QA fields (excluded, validStart, validEnd, qaNotes) | Expanded row | Collapsible "Control de Calidad" section on detail page |
| `DeploymentEditForm` (metadata editing) | Expanded row | Collapsible "Metadata" section on detail page |
| Processing history + job stats | Expanded row | Always-visible section on detail page (already partially exists) |
| Job deletion (`DeleteJobDialog`) | Expanded row per-job | Per-job action in processing history section |
| Video count display | Expanded row metadata | Detail page metadata section |
| Metadata source badge (ODK/Drive/Manual) | Expanded row | Detail page metadata section |
| Share links | Detail page (already exists) | Keep as-is |
| Preview link | Overflow menu → `/camera-trap/[id]/preview` | Link in detail page actions |
| Compress / Revert / Verify Empty / Undo Verify | Overflow menu | Secondary actions section on detail page |
| Open in Drive | Overflow menu | Link in detail page header |
| Delete deployment | Overflow menu | Secondary actions (with confirmation) |

#### 3. Keep `deployment-row-actions.tsx` (simplified)

The table row's overflow menu stays but is slimmed down to the 2-3 most common actions (Process, View Results, Delete). Everything else lives on the detail page.

**Files to modify:**
- `src/app/camera-trap/[id]/page.tsx` — status banner, CTA logic, QA section, edit form, job deletion
- `src/app/camera-trap/deployment-row-actions.tsx` — slim down to essential actions

**No new component files needed** — the status banner CTA is simple enough to live in the page server component with one small client island for the process dialog button.

## Technical Considerations

### Gotchas from institutional learnings

- **better-sqlite3 transactions are synchronous**: `db.transaction(async (tx) => {...})` throws at runtime, TypeScript doesn't catch it
- **Flexbox overflow**: Add `min-w-0` on flex children containing the grouped table
- **Server→Client serialization**: Don't pass React components or functions as props from server to client components

### Performance

- Summary cards: Computed server-side from existing `getDeploymentsWithStats` — zero new queries
- Grouping: Done server-side in `page.tsx` — client receives pre-grouped structure
- Detail page: Existing `getDeployment()` query is sufficient; CTA logic computed server-side

### Testing

- **CTA state machine**: Unit test the pure function mapping `(status, detectionCount, lastJobId, role)` → CTA config
- **Status label mapping**: Unit test the display mapping function
- **Grouped table rendering**: E2E test with multiple projects to verify grouping, collapse, and click-through

## Acceptance Criteria

### Phase A: Grouped Table
- [x] Status badges show simplified Spanish labels (Por Procesar, Por Revisar, etc.)
- [x] `processed` with 0 detections shows "Sin Detecciones" (distinct from "Por Revisar")
- [x] Summary cards show counts by status group at top of page
- [x] Cards respect per-user project access filtering
- [x] Deployments grouped by project with collapsible sections
- [x] Project headers show total count + actionable count
- [x] All groups collapsed by default
- [x] Status filter dropdown works orthogonally to project grouping
- [x] Clicking a deployment row navigates to `/camera-trap/[id]`
- [x] `deployment-expanded-row.tsx` removed (~414 lines deleted)
- [x] Row actions dropdown simplified to essential actions
- [x] Batch operations toolbar works with grouped selection

### Phase B: Detail Page
- [x] Status banner at top with contextual CTA per the matrix above
- [x] CTA handles all statuses correctly for viewer/editor/admin roles
- [x] `processing` status CTA links to active job progress (not just last completed)
- [x] Collapsible metadata section with `DeploymentEditForm` (for editors)
- [x] Collapsible QA section (excluded, valid dates, notes)
- [x] Processing history with per-job deletion
- [x] Video counts displayed
- [x] Metadata source badge shown
- [x] Secondary actions (compress, revert, verify, delete, Drive link, preview)
- [x] CTA state machine has unit tests

## What NOT to build (YAGNI)

- Click-to-scroll from cards to table groups — cards are static counts
- Group-level select-all checkboxes — add if users request it
- Auto-expand groups on search — standard filtering is sufficient
- Nested project → status two-level grouping — one level + status filter is enough
- `camera_trap_sync_meta` table — belongs in the separate sync plan
- Freshness indicator — depends on nightly sync, separate plan
- Nightly Drive auto-sync — separate plan
- Email notifications on sync — separate plan
- Smart expansion / muted groups — start simple, iterate if needed

## Implementation Order

1. **Phase A** ships as one unit — status labels + cards + grouping + row changes all go together
2. **Phase B** ships after Phase A — detail page is ready before expandable rows are removed

> Note: Phase A deletes `deployment-expanded-row.tsx`, so Phase B (which migrates that content to the detail page) must actually be implemented first or simultaneously. In practice, do the detail page migration → then the table refactor → then ship both.

## References

### Key files
- `src/app/camera-trap/deployments-table.tsx` — current table (TanStack config lines 352-372, columns 129-333)
- `src/app/camera-trap/page.tsx` — current landing page
- `src/app/camera-trap/[id]/page.tsx` — current detail page
- `src/app/camera-trap/actions.ts` — data fetching (`getDeploymentsWithStats` line 1113, `DeploymentRow` type line 1081)
- `src/app/camera-trap/deployment-expanded-row.tsx` — content to migrate (~414 lines)
- `src/app/camera-trap/deployment-row-actions.tsx` — actions to slim down
- `src/components/status-badge.tsx` — status label config (line 16)

### Institutional learnings
- `docs/solutions/runtime-errors/async-transaction-better-sqlite3-CameraTrap-20260223.md` — sync-only transactions
- `docs/solutions/ui-bugs/biochoco-overview-horizontal-scroll-map-overlap.md` — flexbox min-w-0 gotcha
