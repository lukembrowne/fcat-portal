---
title: "feat: Camera trap inline row actions and overflow menu"
type: feat
date: 2026-03-02
brainstorm: docs/brainstorms/2026-03-02-camera-trap-workflow-ux-brainstorm.md
---

# Camera Trap Inline Row Actions & Overflow Menu

## Overview

Redesign the camera trap deployments table so each row has a context-aware primary action button and a `···` overflow menu for secondary actions. This replaces the current pattern where all actions are buried in an expanded row that users must click into to discover.

The goal: when a new deployment shows up, it's immediately clear what to do next.

## Problem Statement

The current deployments table requires users to: (1) click a row to expand it, (2) scan a dense wall of metadata and small buttons to find the right action, (3) know which actions are relevant for the deployment's current state. This is unintuitive — especially for new team members — and slows down a workflow that should feel linear (scan → process → review results).

## Proposed Solution

**Smart primary action button** — one button per row showing the logical next step:

| Deployment State | Primary Button | Target |
|---|---|---|
| `unscanned` | "Procesar" | `queueProcessing([id])` (auto-scans internally) |
| `scanned` | "Procesar" | `queueProcessing([id])` |
| `processing` | Spinner + "Procesando..." | disabled |
| `processed` | "Ver Resultados" | `/camera-trap/results/{lastCompletedJobId}` |
| `verified` | "Ver Resultados" | `/camera-trap/results/{lastCompletedJobId}` |
| `verified_empty` | "Ver Resultados" if has job, else "—" | `/camera-trap/results/{lastCompletedJobId}` or nothing |

**Overflow menu (`···`)** — secondary actions grouped with separators:

```
┌──────────────────────────┐
│ 🔍 Buscar Imágenes       │  editor, not processing
│ 🔗 Vincular ODK          │  editor
│ ✏️  Editar Metadatos      │  editor
│ ──────────────────────── │
│ 📦 Comprimir Imágenes    │  admin, has images, not processing
│ ↩️  Deshacer Compresión   │  admin, revertibleImageCount > 0
│ ──────────────────────── │
│ ✅ Verificar Vacío        │  editor, processed + 0 detections
│ ↩️  Deshacer Verificación │  editor, verified_empty
│ ──────────────────────── │
│ 📂 Abrir en Drive        │  anyone, has driveFolderId
│ 🖼️ Ver Preview           │  anyone, has images
│ ──────────────────────── │
│ 🗑️ Eliminar              │  editor, not processing (red text)
└──────────────────────────┘
```

**Table columns simplified** — replace `preview`, `process`, `results` columns with a single `actions` column containing the primary button + overflow trigger.

**Expanded row simplified** — remove action buttons, keep: metadata grid, QA section (editable for editors), processing history.

## Technical Considerations

### Layout
- Table already has 12+ columns. Removing 3 (preview, process, results) and adding 1 (actions) nets -2 columns.
- Must ensure `min-w-0` on the flex container wrapping the table to prevent horizontal overflow when sidebar is open (documented gotcha in `docs/solutions/`).
- Primary button text varies in width ("Procesar" vs "Ver Resultados"). Use a fixed-width column (~160px) to prevent layout shifts.

### Component Architecture
- `deployments-table.tsx` is a Client Component — all action components render client-side, no Server→Client serialization issues.
- Overflow menu needs `shadcn/ui DropdownMenu` component (not yet installed in the project).
- Click propagation: overflow trigger and primary button must call `e.stopPropagation()` to prevent row expansion.

### Existing Backend Support
- `queueProcessing()` already auto-scans unscanned deployments — no backend changes needed for the "Procesar on unscanned" flow.
- `matchOdkDeployments([id])` already works for single deployments — just needs a toast wrapper.
- `deleteDeployments([id])` exists for single deletion — needs a confirmation dialog.

### Permissions
Every overflow menu item is gated by role at the component level AND every server action independently calls `requirePermission()`. No new permission model needed.

## Changes

### 1. Install shadcn DropdownMenu component

**Command:** `npx shadcn@latest add dropdown-menu`

This adds `src/components/ui/dropdown-menu.tsx` with Radix primitives: `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem`, `DropdownMenuSeparator`.

### 2. Create `DeploymentRowActions` component

**New file:** `src/app/camera-trap/deployment-row-actions.tsx`

Client component receiving a `DeploymentRow` + permission flags (`canEdit`, `isAdmin`). Renders:

1. **Primary action button** — switch on `deployment.status`:
   - `unscanned` / `scanned`: green "Procesar" button with Play icon → calls `queueProcessing([id])`, dispatches `job-started` event
   - `processing`: muted "Procesando..." with Loader2 spinner, disabled
   - `processed` / `verified` / `verified_empty`: blue "Ver Resultados" link-button → navigates to `/camera-trap/results/{lastCompletedJobId}` (or disabled dash if no job ID)

2. **Overflow menu trigger** — `MoreHorizontal` icon button, opens `DropdownMenu` with conditional items per the matrix above

3. **Mounted dialogs** — `CompressConfirmDialog`, `RevertConfirmDialog`, `DeleteConfirmDialog` (new), controlled by nullable ID state

All menu actions either: (a) call a server action directly with toast feedback, (b) open a confirmation dialog, or (c) navigate. Menu closes immediately on click.

**Overflow item behaviors:**
- **Buscar Imágenes**: calls `scanDeploymentImages(id)`, toast on success/failure
- **Vincular ODK**: calls `matchOdkDeployments([id])`, toast showing match result
- **Editar Metadatos**: expands the row and activates edit mode (dispatches a custom event `expand-and-edit-${id}`)
- **Comprimir / Deshacer Compresión**: opens respective confirmation dialog
- **Verificar Vacío / Deshacer Verificación**: calls existing `confirmBlankDeployment` / `unconfirmBlankDeployment`, toast
- **Abrir en Drive**: `window.open()` to Drive URL
- **Ver Preview**: `router.push()` to preview page
- **Eliminar**: opens `DeleteConfirmDialog`

### 3. Create `DeleteConfirmDialog` component

**New file:** `src/app/camera-trap/delete-confirm-dialog.tsx`

Follows existing dialog pattern (like `CompressConfirmDialog`). Props: `deploymentId: number | null`, `deploymentName: string`, `onClose`, `onDeleted`. Calls `deleteDeployments([id])`. Destructive variant button. Disabled when `status === "processing"`.

### 4. Modify table columns in `deployments-table.tsx`

**File:** `src/app/camera-trap/deployments-table.tsx`

Remove columns:
- `preview` (images link → moves to overflow "Ver Preview")
- `process` (Procesar button → moves to primary action)
- `results` (Ver Resultados link → moves to primary action)

Add column:
- `actions` — renders `<DeploymentRowActions>` with `stopPropagation` wrapper. Header empty. Fixed width ~160px. Sticky right if possible.

Keep `expand` column (chevron) for row expansion.

Pass `canEdit` and `isAdmin` props through to `DeploymentRowActions`.

### 5. Simplify expanded row

**File:** `src/app/camera-trap/deployment-expanded-row.tsx`

Remove the action buttons flex container (currently ~lines 380-510 with: Abrir en Drive, Editar, Buscar, Procesar, Verificar, Comprimir, Deshacer Compresión).

Keep:
- Metadata grid (proyecto, sitio, coords, dates, images, videos, source)
- QA section (excluded checkbox, valid dates, QA notes, Guardar QA button)
- Processing history (job cards with status, date, counts, Ver Resultados link, delete button)

Remove mounted dialogs that move to `DeploymentRowActions`: `CompressConfirmDialog`, `RevertConfirmDialog`.

Add listener for `expand-and-edit-${deployment.id}` custom event to auto-activate edit mode when triggered from the overflow menu.

### 6. Add toast infrastructure for action feedback

**File:** `src/app/camera-trap/deployments-table.tsx` (or `deployment-row-actions.tsx`)

Use existing toast pattern if available, or add simple toast notifications via `sonner` (already a shadcn/ui dependency). Actions triggered from the overflow menu show:
- Success: "Escaneo completado: 142 imágenes encontradas"
- Success: "Vinculado con ODK: sitio Río Verde, fecha 2026-01-15"
- Failure: "Error: No se encontró coincidencia en ODK"
- Failure: "Error al escanear: {error message}"

Check if `sonner` / `Toaster` is already set up in the app layout. If not, add `<Toaster />` to root layout and install with `npx shadcn@latest add sonner`.

## Acceptance Criteria

- [x] Each deployment row shows a smart primary action button matching its state
- [x] Each row has a `···` overflow menu with contextual secondary actions
- [x] Clicking "Procesar" on an unscanned deployment works (auto-scans then processes)
- [x] Overflow menu items are correctly gated by role (viewer/editor/admin) and deployment state
- [x] Expanded row no longer has action buttons (metadata + QA + history only)
- [x] Clicking "Editar Metadatos" in overflow expands the row and enters edit mode
- [x] Single-deployment delete works via overflow menu with confirmation dialog
- [x] "Vincular ODK" works for individual deployments with toast feedback
- [ ] No layout regressions: table renders cleanly with sidebar open/closed
- [x] `stopPropagation` on all interactive elements prevents accidental row expansion
- [x] Existing batch operations (selection toolbar) continue to work unchanged
- [x] All server actions still enforce `requirePermission()` independently
- [x] `npx tsc --noEmit` passes
- [x] `npm run test:run` passes

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Status badge labels | Keep current labels unchanged | Changing labels is a separate UX task; the inline action button already makes "what to do next" obvious |
| QA section in expanded row | Keep as-is | QA is data entry, not an "action" — it belongs with metadata |
| Verification actions | Move to overflow menu | They're state-specific, infrequent, and would clutter the primary action |
| Batch toolbar | Keep unchanged | Per-row actions and batch operations serve different workflows |
| Delete during processing | Disable "Eliminar" in overflow | Prevents orphaned jobs; user must cancel job first |
| Overflow menu interaction | Close immediately, show toast | Avoids blocking UI; toast provides async feedback |
| "Vincular ODK" | Auto-match by name via existing `matchOdkDeployments` | Manual ODK picker is a separate feature; auto-match covers 90% of cases |
| Progress in `processing` row | Spinner + "Procesando..." text | Real-time per-row progress is complex; `FloatingJobProgress` handles detailed tracking |

## Dependencies

- `shadcn/ui dropdown-menu` component (Radix-based)
- `sonner` toast library (if not already installed — check first)
- No new server actions needed beyond wrapping existing ones with toast feedback
- No database schema changes
- No API route changes

## References

- Brainstorm: `docs/brainstorms/2026-03-02-camera-trap-workflow-ux-brainstorm.md`
- Current table: `src/app/camera-trap/deployments-table.tsx`
- Current expanded row: `src/app/camera-trap/deployment-expanded-row.tsx`
- Server actions: `src/app/camera-trap/actions.ts`, `drive-actions.ts`, `odk-actions.ts`
- Status badges: `src/components/status-badge.tsx`
- Layout overflow fix: `docs/solutions/ui-bugs/biochoco-overview-horizontal-scroll-map-overlap.md`
