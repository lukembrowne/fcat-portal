---
title: "feat: Deployment verification completion tracking"
type: feat
date: 2026-04-04
brainstorm: docs/brainstorms/2026-04-04-deployment-verification-completion-brainstorm.md
---

# feat: Deployment Verification Completion Tracking

## Overview

Camera trap deployments with detections currently stay in `processed` status forever — there's no way to know when a researcher has finished reviewing all identifications. This feature adds verification progress tracking and a completion workflow so deployments transition to `verified` when review is done.

The `verified` status already exists in the schema and UI (StatusBadge, overview stats) but has no code path to reach it. This plan fills that gap.

## Problem Statement / Motivation

- Researchers can't see which deployments still need review or how much work remains
- The overview stats (`porRevisar` vs `verificadas`) are inaccurate — deployments with detections never move to "verificadas"
- No confidence signal for data export — impossible to know if a deployment's data is ready
- The `verified_empty` path works fine (0-detection deployments), but the detection path has no equivalent

## Proposed Solution

### 1. Shared Auto-Completion Helper

Create `maybeAutoCompleteDeployment(deploymentId: number)` in `src/app/camera-trap/actions.ts`:

```typescript
// src/app/camera-trap/actions.ts
async function maybeAutoCompleteDeployment(deploymentId: number): Promise<boolean> {
  // Count unverified identifications for this deployment
  // Scope: ALL identifications reachable via images.deploymentId (across all jobs + manual detections)
  const [result] = await db.select({ count: count() })
    .from(identifications)
    .innerJoin(detections, eq(identifications.detectionId, detections.id))
    .innerJoin(images, eq(detections.imageId, images.id))
    .where(and(
      eq(images.deploymentId, deploymentId),
      eq(identifications.verificationStatus, "unverified")
    ));

  if (result.count === 0) {
    // Check deployment is in "processed" status before transitioning
    const [deployment] = await db.select({ status: ctDeployments.status })
      .from(ctDeployments).where(eq(ctDeployments.id, deploymentId));
    if (deployment?.status === "processed") {
      await db.update(ctDeployments)
        .set({ status: "verified" })
        .where(eq(ctDeployments.id, deploymentId));
      revalidatePath(CAMERA_TRAP_PATH);
      return true;
    }
  }
  return false;
}
```

**Why scope to all identifications via `images.deploymentId`**: This matches the user's mental model ("this deployment is fully reviewed"). Scoping to only the latest job would miss manual detections (`jobId: null`) and leave orphaned identifications blocking completion.

### 2. Hook Into All 7 Verification Mutations

Append `maybeAutoCompleteDeployment(deploymentId)` call to:

| Action | File location | Notes |
|--------|--------------|-------|
| `verifyIdentification` | `actions.ts:~2921` | Single ID verify |
| `rejectIdentification` | `actions.ts:~2954` | Single ID reject |
| `correctIdentification` | `actions.ts:~2987` | Single ID correct / re-correct |
| `bulkVerify` | `actions.ts:~3022` | Mass verify by selection |
| `bulkVerifyByThreshold` | `actions.ts:~3068` | Mass verify by confidence |
| `verifyAndAdvance` | `actions.ts:~3750` | Review workflow (return `deploymentCompleted` flag) |
| `assignSpecies` | `actions.ts:~3640` | Sets verified/corrected status |

For `verifyAndAdvance` specifically: when `nextImageId === null` AND `maybeAutoCompleteDeployment()` returns `true`, include `deploymentCompleted: true` in the response so the client can show a completion toast.

### 3. Verification Progress in DeploymentRow

Add two fields to the `DeploymentRow` interface and `getDeploymentsWithStats()` query:

```typescript
// Added to DeploymentRow interface (actions.ts:~1134)
reviewedCount: number | null;    // count of non-"unverified" identifications
totalIdentifications: number | null;  // total identifications for deployment
```

**Query approach**: Batch query joining `images → detections → identifications` grouped by `images.deploymentId`, similar to existing detection/species count queries at `actions.ts:~1261-1283`. Only computed for deployments that have a completed job (same filter as detection counts).

### 4. Manual "Marcar como Verificada" Action

New server action `markVerified(deploymentId)` in `actions.ts`, modeled on `markVerifiedEmpty` (`actions.ts:~2142`):

- Permission: `requirePermission("camera-trap", "editor")` + `requireDeploymentAccess`
- Guard: deployment must be in `"processed"` status
- **No guard on unverified count** — this is an intentional override ("good enough")
- Individual identification statuses remain unchanged (deployment-level sign-off ≠ identification-level verification)
- Confirmation dialog shows unverified count: *"Hay 12 identificaciones sin revisar. ¿Marcar como verificada de todos modos?"*
- `revalidatePath(CAMERA_TRAP_PATH)`

### 5. Manual "Re-abrir Revisión" Action

New server action `undoVerified(deploymentId)` in `actions.ts`, modeled on `undoVerifiedEmpty` (`actions.ts:~2207`):

- Permission: same as above
- Guard: deployment must be in `"verified"` status
- Transition: `verified` → `processed`
- `revalidatePath(CAMERA_TRAP_PATH)`

### 6. Auto-Revert on New Content

Two revert triggers:

**a) New ML job** — Already handled. `createProcessingJob` (`actions.ts:~115`) sets status to `"processing"` unconditionally, and on completion it becomes `"processed"`. No changes needed.

**b) Manual detection added** — Add a check in `createManualDetection`: if deployment status is `"verified"`, revert to `"processed"` before inserting. This prevents contradictory state (verified deployment with unverified identifications).

### 7. UI Changes

#### Deployments Table (`deployments-table.tsx`)

- Add inline progress text next to the status badge for `"processed"` deployments: `"12/45 revisadas"` in small muted text
- For `"verified"` deployments, show `"45/45 revisadas"` or just the green badge (already handled)

#### Deployment Detail Page (`[id]/page.tsx`)

- Add progress bar or counter in the summary stats section: `"Revisadas: 23/45"` with a visual indicator
- Counter is clickable → navigates to results page filtered to unverified

#### Action Menus

- **`deployment-row-actions.tsx`**: Add "Marcar como Verificada" option (visible when `status === "processed"` and `totalDetections > 0`). Add "Re-abrir Revisión" (visible when `status === "verified"`).
- **`[id]/deployment-detail-actions.tsx`**: Same two actions, same conditions. Mirror existing `markVerifiedEmpty`/`undoVerifiedEmpty` placement.

#### Results Page (`results/[id]/images/[imageId]/image-annotation-client.tsx`)

- When `verifyAndAdvance` returns `deploymentCompleted: true`, show a toast: *"¡Todas las identificaciones revisadas! Instalación marcada como verificada."*

#### Overview Stats (`page.tsx`)

- Already correct — `computeStatusCounts` at line 61-63 counts `"verified"` in `verificadas`. No changes needed.

## Technical Considerations

### Performance

The verification count query adds one more batch query to `getDeploymentsWithStats`, which already runs 4+ queries. For current dataset sizes (~hundreds of deployments, ~tens of thousands of identifications), this is fine. If it becomes slow, denormalize counts onto the deployment row and update on each verification action.

### Schema Migration

**No new schema columns needed.** The `"verified"` status already exists in the enum. Progress counts are derived on-the-fly. If we later want audit fields (`verifiedBy`, `verifiedAt`), those would need `ALTER TABLE` migrations in `scripts/push-schema.mjs`.

### Race Conditions

Two editors verifying the last identification simultaneously: both trigger `maybeAutoCompleteDeployment`, both attempt `SET status = 'verified'`. This is idempotent and safe with SQLite WAL + `busy_timeout`. Toast may double-fire — acceptable.

### Transactions

Per documented gotcha: `better-sqlite3` transactions must be synchronous. The `maybeAutoCompleteDeployment` helper uses async Drizzle queries, so it should NOT be wrapped in `db.transaction()`. Sequential awaits are fine here.

## Acceptance Criteria

- [x] `maybeAutoCompleteDeployment()` helper created and called from all 7 verification-mutating actions
- [x] Deployment auto-transitions `processed → verified` when last identification is reviewed
- [x] Progress counter (`"12/45 revisadas"`) visible on deployments table for `processed` deployments
- [x] Progress counter visible on deployment detail page
- [x] "Marcar como Verificada" button in row actions and detail actions (with confirmation dialog showing unverified count)
- [x] "Re-abrir Revisión" button in row actions and detail actions for `verified` deployments
- [x] Adding manual detection on `verified` deployment reverts to `processed`
- [x] `verifyAndAdvance` shows completion toast when deployment is auto-verified
- [x] Overview stats accurately reflect verified deployments (already works — verify)
- [x] Viewer role can see progress counters but cannot trigger verification actions

## Implementation Phases

### Phase 1: Backend (server actions)
1. `maybeAutoCompleteDeployment()` helper
2. Hook into all 7 verification actions
3. `markVerified()` and `undoVerified()` actions
4. Auto-revert in `createManualDetection`
5. Add `reviewedCount`/`totalIdentifications` to `getDeploymentsWithStats()`
6. Add `deploymentCompleted` flag to `verifyAndAdvance` response

### Phase 2: UI
1. Progress counter in deployments table
2. Progress counter on deployment detail page
3. "Marcar como Verificada" + confirmation dialog in both action menus
4. "Re-abrir Revisión" in both action menus
5. Completion toast in image annotation client

### Phase 3: Verify & Polish
1. Test auto-completion with single verify, bulk verify, reject, correct
2. Test manual sign-off with unverified remaining
3. Test revert flows (re-open, new ML job, manual detection)
4. Verify overview stats accuracy
5. Check viewer role sees progress but no action buttons

## Dependencies & Risks

- **Low risk**: No schema migration needed — `verified` status already exists
- **Medium risk**: 7 mutation points to hook into — must not miss any, or auto-completion is inconsistent. Mitigate with a shared helper and thorough testing.
- **Low risk**: Performance of count query — acceptable for current scale, can denormalize later

## Key Files

| File | Changes |
|------|---------|
| `src/app/camera-trap/actions.ts` | `maybeAutoCompleteDeployment`, `markVerified`, `undoVerified`, hook into 7 verification actions, update `getDeploymentsWithStats` |
| `src/app/camera-trap/deployments-table.tsx` | Progress counter display |
| `src/app/camera-trap/[id]/page.tsx` | Progress counter on detail page |
| `src/app/camera-trap/deployment-row-actions.tsx` | "Marcar como Verificada" + "Re-abrir Revisión" menu items |
| `src/app/camera-trap/[id]/deployment-detail-actions.tsx` | Same two menu items |
| `src/app/camera-trap/results/[id]/images/[imageId]/image-annotation-client.tsx` | Completion toast |
| `src/app/camera-trap/page.tsx` | Verify overview stats (likely no changes needed) |

## References

- Brainstorm: `docs/brainstorms/2026-04-04-deployment-verification-completion-brainstorm.md`
- Template pattern: `markVerifiedEmpty` / `undoVerifiedEmpty` at `actions.ts:~2142-2244`
- Existing progress UI: `src/components/floating-job-progress.tsx`
- Gotcha: async transactions with better-sqlite3 — `docs/solutions/runtime-errors/async-transaction-better-sqlite3-CameraTrap-20260223.md`
- Gotcha: ALTER TABLE migrations — `docs/solutions/database-issues/missing-alter-table-migrations-push-schema.md`
