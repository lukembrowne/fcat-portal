---
title: "feat: Add verified_empty deployment status for camera traps"
type: feat
date: 2026-02-15
brainstorm: docs/brainstorms/2026-02-15-verified-empty-deployments-brainstorm.md
---

# feat: Add verified_empty deployment status for camera traps

## Overview

Add a `verified_empty` status to the camera trap deployment state machine so researchers can confirm that a deployment with zero ML detections is legitimately empty — distinguishing "no animals here" (ecologically meaningful) from "not yet reviewed" or "something went wrong."

## Problem Statement

After ML processing, deployments with no animal detections show `status="processed"` with "0 detections, 0 species." There's no way to distinguish:
- **Legitimate zero**: camera ran correctly, no animals passed — useful ecological data
- **Unreviewed zero**: nobody has looked at it yet — could be an error
- **Error zero**: camera malfunction, wrong angle, corrupted files — needs attention

Researchers need to mark the first case explicitly so the team knows which empty deployments have been reviewed.

## Proposed Solution

Add `"verified_empty"` as a new deployment status value. A button appears in the expanded row when a deployment is `processed` with 0 detections. Editors/Admins click it to confirm the deployment is legitimately empty.

### State Machine

```
unscanned → scanned → processing → processed → verified (has detections, species reviewed)
                                        ↓ (0 detections)
                                   verified_empty (confirmed no animals)
                                        ↕ (undo / re-process)
                                     processed
```

- `verified` and `verified_empty` are **mutually exclusive terminal states** from `processed`
- `verified` = deployment has detections and species IDs have been reviewed
- `verified_empty` = deployment has 0 detections and a researcher confirmed this is correct
- Both reset to `processed` if re-processed

## Acceptance Criteria

- [x] New `verified_empty` value in the deployment status enum (`src/db/schema.ts`)
- [x] SQLite migration in `push-schema.mjs` updates the CHECK constraint for existing databases
- [x] StatusBadge shows "Vacía verificada" with a distinct color (e.g., `bg-slate-500`)
- [x] "Verificar vacío" button in expanded row when `status === "processed"` AND `totalDetections === 0`
- [x] "Deshacer verificación" button in expanded row when `status === "verified_empty"`
- [x] Both buttons require Editor or Admin role (`requirePermission("camera-trap", "editor")`)
- [x] Server action validates deployment is `processed` with 0 detections before allowing transition
- [x] Re-processing a `verified_empty` deployment resets status to `processing` (existing flow handles this)
- [x] Filter dropdown includes "Vacía verificada" option
- [x] Status legend includes explanation for verified_empty
- [x] Button shows loading state (disabled + spinner) during server action

## Implementation Plan

### Step 1: Schema + Migration

**Files:**
- `src/db/schema.ts:99` — Add `"verified_empty"` to the status enum array
- `scripts/push-schema.mjs:68` — Update `CHECK(status IN (...))` in CREATE TABLE for new databases
- `scripts/push-schema.mjs` migrations array — Add table recreation migration for existing databases

The migration follows the existing pattern at `push-schema.mjs:362-396` (table recreation to update CHECK constraints in SQLite). Steps:
1. Create `biochoco_deployments_new` with updated CHECK constraint
2. Copy all data from `biochoco_deployments`
3. Drop old table
4. Rename new table
5. Recreate indexes

### Step 2: StatusBadge Config

**File:** `src/components/status-badge.tsx:24`

Add entry to `DEPLOYMENT_STATUS_CONFIG`:
```typescript
verified_empty: { variant: "default", label: "Vacía verificada", className: "bg-slate-500" },
```

### Step 3: Server Actions

**File:** `src/app/camera-trap/actions.ts`

Two new exported async functions:

**`markVerifiedEmpty(deploymentId: number): Promise<ActionResult>`**
- `requirePermission("camera-trap", "editor")`
- Query deployment: verify `status === "processed"`
- Query detection count for this deployment's latest completed job: verify `count === 0`
- Update deployment `status = "verified_empty"`
- `revalidatePath("/camera-trap")`
- Return `{ success: true, data: undefined }`

**`undoVerifiedEmpty(deploymentId: number): Promise<ActionResult>`**
- `requirePermission("camera-trap", "editor")`
- Query deployment: verify `status === "verified_empty"`
- Update deployment `status = "processed"`
- `revalidatePath("/camera-trap")`
- Return `{ success: true, data: undefined }`

Also: ensure `createProcessingJob()` allows transitioning from `verified_empty` → `processing` (the existing code sets `status = "processing"` unconditionally, so this likely works already, but verify).

### Step 4: Expanded Row Buttons

**File:** `src/app/camera-trap/deployment-expanded-row.tsx:176-219`

Add two conditional buttons in the action buttons area (after existing buttons):

```
{canEdit && deployment.status === "processed" && deployment.totalDetections === 0 && (
  <Button onClick={handleVerifyEmpty}>Verificar vacío</Button>
)}
{canEdit && deployment.status === "verified_empty" && (
  <Button variant="outline" onClick={handleUndoVerify}>Deshacer verificación</Button>
)}
```

Use `useTransition()` for loading state on the buttons.

### Step 5: Deployments Table Filter + Legend

**File:** `src/app/camera-trap/deployments-table.tsx`

- Line 444: Add `<option value="verified_empty">Vacía verificada</option>` to filter dropdown
- Line 472: Add legend entry:
  ```
  <span>
    <StatusBadge status="verified_empty" type="deployment" />
    Sin detecciones, confirmada por investigador
  </span>
  ```

## Edge Cases

- **Race condition**: Server action checks detection count in the same query as status check — if detections were added between page load and button click, the action fails gracefully with an error message
- **Concurrent edits**: Last write wins (acceptable — same pattern as all other deployment actions)
- **Re-processing**: Existing `createProcessingJob()` sets `status = "processing"` regardless of current status, which naturally resets `verified_empty`
- **Button hidden for Viewers**: Only shown when `canEdit` is true (existing permission pattern in expanded row)

## References

- Brainstorm: `docs/brainstorms/2026-02-15-verified-empty-deployments-brainstorm.md`
- Schema: `src/db/schema.ts:82-127`
- StatusBadge: `src/components/status-badge.tsx:16-25`
- Deployments table: `src/app/camera-trap/deployments-table.tsx:431-473`
- Expanded row: `src/app/camera-trap/deployment-expanded-row.tsx:176-219`
- Server actions: `src/app/camera-trap/actions.ts`
- Push schema migrations: `scripts/push-schema.mjs:362-396`
- Learnings: `docs/solutions/database-issues/missing-alter-table-migrations-push-schema.md`
