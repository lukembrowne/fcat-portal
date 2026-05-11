---
title: Audio Instalaciones — Parity with Camera-Trap (Table UI + Drive Sync + Nightly Cron)
type: feat
date: 2026-05-11
status: planning
---

# Audio Instalaciones — Parity with Camera-Trap (Table UI + Drive Sync + Nightly Cron)

## Overview

Port the recent camera-trap improvements onto the audio (`/audio` aka "Grabaciones") instalaciones page so the two modules behave like siblings: same table interactions, same Drive-sync UX, same nightly cron, and shared primitives wherever the logic is identical. Landing pages, statuses, and module-specific workflows stay separate.

The mental model the user wants going forward:

> "Two landing pages, two workflows, but if a feature applies to both modules it lives in one place and propagates to both automatically."

This plan does **two** things at once:

1. Ships the missing audio features (multi-select table, background Drive sync, batch actions, nightly cron entry).
2. Establishes the reusable primitives (`useRowRangeSelection`, `drive-sync-worker-core`, generic `BatchEditDialog`) that next-time-this-happens, only one place needs changing.

## Problem Statement / Motivation

Recent main-branch work (`5381c11`, `152186b`, `600f270`, `102bd6f`, `11238d5`, `850cccb`) overhauled the camera-trap instalaciones page:

- Default sort by deployment name within each project group.
- Per-group "select all" checkbox + shift+click range selection.
- Drive sync moved off the request thread onto a background `processingJobs` worker with `p-limit` fan-out.
- Nightly cron rewritten to use the worker (instead of an inline loop) and now includes delta reporting.
- Split-button picker in the toolbar lets editors sync all CT projects or just one.

The audio page (`src/app/audio/audio-deployments-shell.tsx`) is essentially a v1 fork: it has TanStack sorting and a search box but no multi-select, no checkbox column, no batch actions, no background-job UX, and no cron entry. `scanAllAudio` (`src/app/audio/actions.ts:403`) is a synchronous for-loop that blocks the request thread for as long as the largest Drive folder takes — fragile and unobservable. Audio inventory drift accumulates because nothing refreshes it nightly.

This divergence will only grow as more features (export, batch-delete, batch-edit, brightness controls, results live-refresh) land on camera-trap. We need to (a) close the gap now and (b) lower the cost of future ports by lifting the genuinely-shared pieces.

## Proposed Solution

A 6-phase implementation, executed on a new branch cut from `main` **after** `feat/birdnet-audio-analysis` is merged. Each phase ends in a green build and ideally a green test run — small, reviewable PRs preferred.

1. **Land prerequisites.** Merge `feat/birdnet-audio-analysis` → `main`, then cut `feat/audio-instalaciones-parity` from the freshly-updated main.
2. **Extract shared primitives.** Pull selection logic, sync-worker scaffolding, and the batch dialogs out of camera-trap into module-agnostic homes. Camera-trap rewires to use them — same behaviour, less code.
3. **Build the audio sync worker** on top of the shared core. Add `enqueueAudioSyncJob`, replace `scanAllAudio` with it.
4. **Port the table UI** to audio: default sort, checkbox column, per-group select-all, shift+click range, split-button picker.
5. **Wire into nightly cron** sequentially after the camera-trap sync, with audio stats in the email.
6. **Audio batch actions** scoped to what actually makes sense for audio (exclude/include, re-scan, queue BirdNET, batch-delete).

## Technical Approach

### Architecture: where the seams go

```
src/lib/
├── drive-sync-worker-core.ts        # NEW: generic job lifecycle + p-limit fan-out
├── camera-trap-sync-worker.ts       # uses worker-core, supplies CT-specific scanDeployment
├── camera-trap-sync-internals.ts    # unchanged (CT-specific image/odk/upload logic)
├── audio-sync-worker.ts             # NEW: uses worker-core, supplies audio scanDeployment
└── audio-sync-internals.ts          # NEW: scanDeploymentAudioInternal (refactored from actions.ts)

src/hooks/
└── use-row-range-selection.ts       # NEW: shift+click anchored range selection

src/components/deployments/
├── batch-edit-dialog.tsx            # NEW (moved from camera-trap, generalised)
├── batch-delete-dialog.tsx          # NEW (moved from camera-trap, generalised)
└── deployment-group-row.tsx         # NEW: per-group header + select-all checkbox

src/app/camera-trap/deployments-table.tsx   # rewired to use shared primitives
src/app/audio/audio-deployments-shell.tsx   # rewritten to use shared primitives
src/app/audio/drive-actions.ts              # NEW: enqueueAudioSyncJob + helpers
src/app/api/cron/nightly-refresh/route.ts   # extended with audio-sync stage
```

The seam between "shared" and "module-specific" is drawn so that:

- **Shared = pure UX or generic plumbing** with no domain knowledge (selection state, p-limit fan-out, job status polling, batch-edit form for a generic `{ id, ctProjectName, excluded, ... }` shape).
- **Module-specific = anything that knows about images vs. audio files**: the scanner function, the per-row column set, the status pill, the email delta section.

This matches the pattern you already used for annotation chrome (commit `d09d612`).

### Phase 0: Prerequisites (Branch Strategy)

Per the planning conversation, work happens **after** the current branch lands.

```bash
# On feat/birdnet-audio-analysis, ensure green
npm run test:run && npm run build

# Open PR, merge to main
gh pr create --title "feat(audio): BirdNET integration + annotation parity" ...
# (merge via UI after review)

# Cut new branch from refreshed main
git checkout main && git pull
git checkout -b feat/audio-instalaciones-parity
```

**Why first**: The current branch reverts `camera-trap-sync-worker.ts` and `camera-trap-sync-internals.ts` (see `git diff main..HEAD --stat`). Working in this branch would mean re-resolving 7K lines of diff against features we explicitly want to keep. Merging first means the new branch starts from the actual current state of camera-trap.

### Phase 1: Extract Shared Primitives

#### 1a. Selection hook

Lift the shift+click range-selection logic out of `deployments-table.tsx` (lines ~94–266 on main) into a reusable hook.

```ts
// src/hooks/use-row-range-selection.ts

import { useRef, useCallback } from "react";
import type { RowSelectionState } from "@tanstack/react-table";

export interface RowRangeSelectionApi {
  /** Spread onto each row's checkbox onClick to capture shiftKey. */
  onCheckboxClick: (e: React.MouseEvent) => void;
  /** Spread onto each row's checkbox onCheckedChange. */
  handleCheckedChange: (rowId: number, checked: boolean) => void;
  /** Update whenever the visible/filtered row order changes. */
  setVisibleOrderedIds: (ids: number[]) => void;
}

export function useRowRangeSelection(
  setRowSelection: React.Dispatch<React.SetStateAction<RowSelectionState>>
): RowRangeSelectionApi {
  const lastSelectedIdRef = useRef<number | null>(null);
  const shiftClickRef = useRef(false);
  const visibleOrderedIdsRef = useRef<number[]>([]);

  // ... same logic as main's deployments-table, but exposed as callbacks
}
```

**Why a hook, not a component**: keeps the column cell renderer in the page (which still owns the checkbox visuals + aria labels in module-local Spanish) but moves the gnarly ref-based bookkeeping to one place. Net code in camera-trap drops by ~80 lines.

#### 1b. Generic sync worker core

Today `src/lib/camera-trap-sync-worker.ts` (`runDriveSyncWorker`, `awaitJobTerminal`) hardcodes the camera-trap deployment filter, the per-deployment scanner (`scanDeploymentImagesInternal`), and the `processingJobs.jobType === "drive_sync"` check. Refactor to:

```ts
// src/lib/drive-sync-worker-core.ts  (NEW)

export interface DriveSyncWorkerConfig<TDeployment> {
  /** Job type marker, e.g. "drive_sync" (CT) or "audio_sync". Used to filter
   *  single-flight checks and pick rows. */
  jobType: "drive_sync" | "audio_sync";
  /** Pull the deployments this job should scan (already permission-checked). */
  listDeployments: (
    job: ProcessingJob,
    options: { skipFinalisedStatuses: boolean }
  ) => Promise<TDeployment[]>;
  /** Per-deployment scan logic; reports created/matched/unmatched. */
  scanOne: (deployment: TDeployment, jobId: number) => Promise<ScanResult>;
  /** Post-loop hook for things like ODK matching, upload-count refresh. */
  afterAll?: (results: ScanResult[]) => Promise<void>;
  /** revalidatePath target for SSR refresh. */
  revalidatePath: "/camera-trap" | "/audio";
  /** Last-sync key for app_state. */
  lastSyncStateKey: string;
}

export async function runDriveSyncWorkerGeneric<T>(
  jobId: number,
  config: DriveSyncWorkerConfig<T>
): Promise<void> { /* ... */ }

export { awaitJobTerminal } from "./drive-sync-worker-internals";
```

Camera-trap version shrinks to:

```ts
// src/lib/camera-trap-sync-worker.ts  (NEW form)

import { runDriveSyncWorkerGeneric } from "./drive-sync-worker-core";
import {
  scanDeploymentImagesInternal,
  refreshUploadCountsInternal,
  matchOdkDeploymentsInternal,
} from "./camera-trap-sync-internals";

export async function runDriveSyncWorker(jobId: number) {
  return runDriveSyncWorkerGeneric(jobId, {
    jobType: "drive_sync",
    listDeployments: listCameraTrapDeployments,
    scanOne: scanDeploymentImagesInternal,
    afterAll: async (results) => {
      await refreshUploadCountsInternal();
      await matchOdkDeploymentsInternal(results);
    },
    revalidatePath: "/camera-trap",
    lastSyncStateKey: CAMERA_TRAP_DRIVE_LAST_SYNC_KEY,
  });
}
```

**Risk to manage**: this is a non-trivial refactor of a hot path. Mitigation: keep `runDriveSyncWorker`'s signature stable and run the existing CT integration test suite. Treat camera-trap as the reference; audio is the second consumer that validates the abstraction.

#### 1c. Shared batch dialogs

Move `batch-edit-dialog.tsx` and `batch-delete-dialog.tsx` from `src/app/camera-trap/` to `src/components/deployments/`. Make them accept a callback prop for the actual mutation rather than calling camera-trap actions directly.

```tsx
// src/components/deployments/batch-edit-dialog.tsx

interface BatchEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedIds: number[];
  /** Module-specific mutation. */
  onSubmit: (ids: number[], fields: BatchEditFields) => Promise<ActionResult>;
  /** Module name for telemetry / error copy. */
  module: "camera-trap" | "audio";
}
```

### Phase 2: Audio Sync Worker

#### 2a. Extract audio scan internals

Refactor `scanDeploymentAudio` (`src/app/audio/actions.ts:273`) into a pure internals module:

```ts
// src/lib/audio-sync-internals.ts  (NEW)

export async function scanDeploymentAudioInternal(
  deployment: { id: number; uploadAudioFolderId: string },
  jobId: number
): Promise<ScanResult> {
  // same logic as actions.ts:294–388, but:
  //   - takes deployment row (not just id) so we skip the lookup
  //   - reports progress via processingJobs row updates (statusMessage, processedImages)
  //   - checks job cancellation between Drive list and DB transaction
}
```

Keep `scanDeploymentAudio` in `actions.ts` as a thin wrapper that calls the internal (for the single-deployment "Re-scan" UI button), wrapping it in a fresh `processingJobs` row scoped to that one deployment.

#### 2b. Audio sync worker

```ts
// src/lib/audio-sync-worker.ts  (NEW)

import { runDriveSyncWorkerGeneric, awaitJobTerminal } from "./drive-sync-worker-core";
import { scanDeploymentAudioInternal } from "./audio-sync-internals";
import { AUDIO_DRIVE_LAST_SYNC_KEY } from "./app-state-keys";

export async function runAudioSyncWorker(jobId: number): Promise<void> {
  return runDriveSyncWorkerGeneric(jobId, {
    jobType: "audio_sync",
    listDeployments: listAudioEligibleDeployments,
    scanOne: scanDeploymentAudioInternal,
    revalidatePath: "/audio",
    lastSyncStateKey: AUDIO_DRIVE_LAST_SYNC_KEY,
  });
}

export { awaitJobTerminal };

async function listAudioEligibleDeployments(job, { skipFinalisedStatuses }) {
  // WHERE upload_audio_folder_id IS NOT NULL
  //   AND (job.cameraTrapProjectId IS NULL OR ct_project_id = job.cameraTrapProjectId)
  //   AND excluded = false  -- audio QA exclusion
}
```

#### 2c. Schema additions

`processingJobs.jobType` is currently `text("job_type").notNull().default("ml")` — no enum constraint, so we can use new values without a column migration. But add app-level constant for safety:

```ts
// src/lib/job-types.ts  (NEW small file)

export const JOB_TYPES = {
  ML: "ml",
  BIRDNET: "birdnet",
  DRIVE_SYNC: "drive_sync",
  AUDIO_SYNC: "audio_sync",
} as const;
export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];
```

Add `AUDIO_DRIVE_LAST_SYNC_KEY = "audio.drive.lastSyncAt"` to `src/lib/app-state-keys.ts`.

#### 2d. Action: enqueueAudioSyncJob

```ts
// src/app/audio/drive-actions.ts  (NEW)

"use server";

export async function enqueueAudioSyncJob(
  cameraTrapProjectId?: number
): Promise<ActionResult<{ jobId: number }>> {
  const user = await requirePermission("grabaciones", "editor");

  // Same single-flight pattern as camera-trap (one audio_sync job at a time)
  const [inflight] = await db
    .select({ id: processingJobs.id })
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.jobType, JOB_TYPES.AUDIO_SYNC),
        inArray(processingJobs.status, ["pending", "processing"])
      )
    );
  if (inflight) {
    return { success: false, error: "Ya hay una sincronización de audio en curso" };
  }

  // Permission check on requested project (if any) — same as CT
  // ...

  const [job] = await db.insert(processingJobs).values({
    jobType: JOB_TYPES.AUDIO_SYNC,
    cameraTrapProjectId: cameraTrapProjectId ?? null,
    status: "pending",
    statusMessage: "En cola...",
    createdBy: user.email,
  }).returning();

  after(() =>
    runAudioSyncWorker(job.id).catch((err) =>
      log.error({ err, jobId: job.id }, "[audio-sync] worker rejected")
    )
  );

  return { success: true, data: { jobId: job.id } };
}

// Delete the synchronous scanAllAudio from actions.ts — its only caller is the
// "Escanear Todo" button, which now calls enqueueAudioSyncJob.
```

### Phase 3: Port the Table UI

Rewrite `src/app/audio/audio-deployments-shell.tsx` so it mirrors camera-trap's `deployments-table.tsx` structurally. Key changes:

#### 3a. Default sort by name

```tsx
const [sorting, setSorting] = useState<SortingState>([
  { id: "name", desc: false },  // was: []
]);
```

#### 3b. Checkbox column + selection state

```tsx
const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
const selection = useRowRangeSelection(setRowSelection);

// Inside columns useMemo:
{
  id: "select",
  header: ({ table }) => (
    <Checkbox
      checked={table.getIsAllPageRowsSelected() ||
               (table.getIsSomePageRowsSelected() && "indeterminate")}
      onCheckedChange={(v) => table.toggleAllPageRowsSelected(!!v)}
      aria-label="Seleccionar todo"
    />
  ),
  cell: ({ row }) => (
    <Checkbox
      checked={row.getIsSelected()}
      onClick={selection.onCheckboxClick}
      onCheckedChange={(v) =>
        selection.handleCheckedChange(row.original.id, !!v)}
      aria-label="Seleccionar fila (mantén Shift para seleccionar un rango)"
    />
  ),
  enableSorting: false,
  enableGlobalFilter: false,
},
```

#### 3c. Per-group select-all

Inside the group header row (currently `audio-deployments-shell.tsx:368`), inject a group-scoped checkbox:

```tsx
<TableRow className="bg-muted/30 hover:bg-muted/50 cursor-pointer border-b">
  <TableCell className="w-8">
    <GroupSelectAllCheckbox
      groupDeploymentIds={group.deployments.map((d) => d.id)}
      rowSelection={rowSelection}
      setRowSelection={setRowSelection}
    />
  </TableCell>
  <TableCell colSpan={columns.length - 1} onClick={() => toggleGroup(group.projectLabel)}>
    ...
  </TableCell>
</TableRow>
```

Extract `GroupSelectAllCheckbox` into `src/components/deployments/group-select-all-checkbox.tsx` so camera-trap can use it too.

#### 3d. Split-button picker for sync

Replace the simple "Escanear Todo" button with the same dropdown camera-trap uses (`deployments-table.tsx:541` area on main):

```tsx
<DropdownMenu>
  <DropdownMenuTrigger asChild>
    <Button variant="outline" size="sm" disabled={syncing}>
      {syncing ? <Loader2 className="animate-spin" /> : <FolderSync />}
      Sincronizar audio
      <ChevronDown />
    </Button>
  </DropdownMenuTrigger>
  <DropdownMenuContent>
    <DropdownMenuLabel>Sincronizar</DropdownMenuLabel>
    <DropdownMenuItem onClick={() => handleSync(undefined)}>
      Todos los proyectos
    </DropdownMenuItem>
    <DropdownMenuSeparator />
    {distinctProjects.map((p) => (
      <DropdownMenuItem key={p.id} onClick={() => handleSync(p.id)}>
        Solo {p.name}
      </DropdownMenuItem>
    ))}
  </DropdownMenuContent>
</DropdownMenu>
```

`handleSync` calls `enqueueAudioSyncJob(projectId)`, dispatches `window.dispatchEvent(new Event("job-started"))` so the existing `floating-job-progress` UI picks it up, and shows a "Sincronización iniciada — puedes seguir trabajando" toast.

#### 3e. Audio-specific column considerations

Audio columns differ from CT — keep these as-is:
- "Archivos" (audio file count) instead of "Imágenes"
- "Detecciones" + "Especies" (BirdNET output) instead of "Procesado"
- Audio status pills (`unscanned/scanned/birdnet_processing/analyzed/reviewed`) stay separate from CT's

Same shape, different cells. That's exactly the line the abstraction draws.

### Phase 4: Wire Into Nightly Cron

Extend `src/app/api/cron/nightly-refresh/route.ts` to run audio sync sequentially after camera-trap.

```ts
// After camera-trap sync completes:
const audioJob = await enqueueAudioSyncJob();  // no project filter = all
if (!audioJob.success) {
  log.error({ err: audioJob.error }, "[nightly] failed to enqueue audio sync");
} else {
  await awaitJobTerminal(audioJob.data.jobId, {
    timeoutMs: AUDIO_TIMEOUT_MS,
    pollMs: POLL_INTERVAL_MS,
  });
}

// Then collect audio stats for the email...
const audioStats = await getAudioNightlyStats();
// Include in snapshot + email body
```

**Email report extension**: add an "Audio" section to the existing email template (modeled on the per-installation deltas added in `4d2f71d`):

```
🎙️ Audio (BirdNET)
  - Instalaciones con audio: 47 (+3)
  - Archivos: 12,438 (+524)
  - Detecciones nuevas: 1,203
  - Instalaciones procesadas hoy: 5
```

Use the same `uploadCountSnapshots` table (it already tracks `totalAudio` + `totalAudioSizeBytes`) so the delta calculation is essentially free.

**Cron entry**: no change — `scripts/crontab` already runs `nightly-refresh` at 1 AM ET. Just bumps the run length by however long audio sync takes. Audit `NIGHTLY_TIMEOUT_MS = 540_000` budget: if audio scan adds >2 min consistently, raise both `--max-time` in crontab and `NIGHTLY_TIMEOUT_MS` together.

### Phase 5: Audio Batch Actions

Determine the bulk operations that are actually useful for audio editors. Proposed set:

| Action | Description | Maps to |
|---|---|---|
| **Batch edit** | Set `excluded` flag + `qaNotes` on N rows | New `batchUpdateAudioDeployments` action |
| **Batch re-scan** | Force-enqueue an `audio_sync` job scoped to the selected deployment IDs | `enqueueAudioSyncJob({ deploymentIds })` overload |
| **Batch BirdNET** | Enqueue a BirdNET job for each selected deployment that has files | Loop over `createBirdNETJob` (concurrency-limited by the existing per-job guard) |
| **Batch delete (audio files)** | Hard-delete scanned audio file rows for selected deployments — does NOT delete from Drive, just clears the local index so they re-scan fresh | New action; gated to admin role for safety |

Reuse the shared `BatchEditDialog` from Phase 1c. Add a `BatchAnalyzeDialog` (BirdNET) and `BatchDeleteAudioDialog` (file-index clear) — these are audio-only.

Toolbar appears only when `selectedRows.length > 0`, matching camera-trap's pattern (line 744 on main):

```tsx
{selectedRows.length > 0 && (
  <div className="mb-3 flex items-center gap-2 rounded-md border bg-card px-3 py-2">
    <span className="text-sm">{selectedRows.length} seleccionado(s)</span>
    <Button onClick={() => setBatchEditOpen(true)}>Editar</Button>
    <Button onClick={() => setBatchAnalyzeOpen(true)}>Analizar con BirdNET</Button>
    <Button onClick={handleBatchRescan}>Re-escanear</Button>
    {isAdmin && (
      <Button variant="destructive" onClick={() => setBatchDeleteOpen(true)}>
        Limpiar índice
      </Button>
    )}
  </div>
)}
```

### Phase 6: Tests + Verification

#### Unit tests

- `tests/unit/hooks/use-row-range-selection.test.tsx` — shift+click anchored range, plain click resets anchor, shift+click without anchor falls back to single toggle.
- `tests/unit/lib/audio-sync-internals.test.ts` — `scanDeploymentAudioInternal` with mocked Drive client + in-memory SQLite (see `tests/helpers/test-db.ts`); covers add / update / soft-delete-with-annotations / hard-delete branches.
- `tests/unit/lib/drive-sync-worker-core.test.ts` — generic worker honours cancellation, calls `afterAll`, surfaces partial failures.

#### E2E

- `tests/e2e/audio-instalaciones.spec.ts` — load page, shift-click 3 rows, assert toolbar shows "3 seleccionado(s)", trigger batch BirdNET dialog.
- Extend existing camera-trap E2E to assert behaviour is unchanged after the refactor (regression guard for Phase 1).

#### Manual verification

- Trigger "Sincronizar audio → Solo BIOCHOCO" from UI; confirm `floating-job-progress` shows progress and table refreshes when done.
- Trigger nightly cron manually in dev: `docker compose exec portal curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/nightly-refresh` — confirm audio section in email and `uploadCountSnapshots` row created.
- Confirm shift+click range selection across collapsed groups behaves identically to camera-trap.

## Alternative Approaches Considered

**Generic `DeploymentsTable<T>` component.** Considered (option B from the planning conversation) but rejected — the per-column rendering, status pill semantics, and per-row action menus diverge enough that the generic version becomes a heap of conditional logic. Shared primitives + duplicated shell hits the right point on the abstraction curve.

**Parallel audio + CT sync in nightly cron.** Faster, but doubles Drive API pressure (CT can already throttle), complicates the email summary, and makes it harder to attribute failures. Sequential keeps the post-mortem story linear.

**Separate `/api/cron/nightly-audio-refresh` endpoint.** Cleaner separation but loses the "one nightly email" UX and adds a second cron line to maintain. User explicitly chose same endpoint.

**Make `scanAllAudio` async without the worker infrastructure.** Tempting (smaller change), but loses cancellation, progress reporting, single-flight protection, and the floating-job UI integration. We get those for free by reusing the worker pattern.

## Acceptance Criteria

### Functional Requirements

- [ ] `/audio` page shows a checkbox column with shift+click range selection that behaves identically to `/camera-trap`.
- [ ] Each project group on `/audio` has a select-all checkbox that toggles only its group's rows.
- [ ] Default sort on `/audio` is by deployment name ascending within each group.
- [ ] "Escanear Todo" button is replaced by a split-button dropdown: "Todos los proyectos" + one item per accessible CT project.
- [ ] Clicking a sync option enqueues an `audio_sync` job and shows progress in the existing `floating-job-progress` widget.
- [ ] Only one `audio_sync` job can be active at a time (UI shows error toast).
- [ ] Selecting rows reveals a batch-action toolbar: Editar, Analizar con BirdNET, Re-escanear; Limpiar índice (admin only).
- [ ] Nightly cron at 1 AM ET runs camera-trap sync, then audio sync, then sends one email containing both sections.
- [ ] Email includes audio deltas: new files, new detections, top-5 deployments by new detections.
- [ ] Camera-trap behaviour is unchanged (regression-free refactor in Phase 1).

### Non-Functional Requirements

- [ ] Audio sync worker respects `DRIVE_SYNC_CONCURRENCY` env var (same as camera-trap).
- [ ] Audio sync survives partial failures — one deployment with a broken Drive folder doesn't fail the whole job.
- [ ] Worker checks for job cancellation between deployments (same cadence as CT).
- [ ] Nightly cron stays within `--max-time 600` budget; audio phase has its own `AUDIO_TIMEOUT_MS` constant.
- [ ] No new direct database writes from server actions — all bulk operations go through transactions (see `tests/unit/CLAUDE.md` async-transaction gotcha).

### Quality Gates

- [ ] `npm run test:run` passes including new unit tests.
- [ ] `npm run test:e2e` passes including new audio E2E.
- [ ] `npm run build` produces a clean production build.
- [ ] `npm run lint` clean.
- [ ] Manual smoke-test in dev (Docker compose) verifies golden-path + at least one error case (folder missing on Drive).
- [ ] Backup taken before deploy: `docker compose exec portal node scripts/backup-db.mjs`.

## Success Metrics

- Time from "Sincronizar audio" click to UI being interactive again: <500ms (vs. however long the synchronous loop takes today).
- Cron run-time stays under 9 minutes (current `NIGHTLY_TIMEOUT_MS`) even with full audio sync.
- Zero divergence between camera-trap and audio for shared primitives — measurable as: when next feature lands in either module's selection/sync code, only one file needs changing.

## Dependencies & Prerequisites

- `feat/birdnet-audio-analysis` merged to main first (Phase 0).
- `processingJobs` schema on main already supports `jobType` as a free-text column — no migration needed for the new `"audio_sync"` value.
- `uploadAudioCount` and `uploadAudioFolderId` columns already exist on `deployments`.
- `floating-job-progress` already handles arbitrary `jobType` values via `cancelProcessingJob` in `actions.ts:725` (already routes by type) — needs a third branch for `audio_sync`, which should just delete the job row (no PID to kill — the worker is in-process).
- `p-limit` already in `package.json` (added in `14770e7`).

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Camera-trap regression from worker-core extraction | Medium | High | Phase 1 is a pure refactor — run full CT integration tests; consider doing Phase 1 as its own PR so it can be reverted independently. |
| Audio sync adds enough time to bust nightly cron timeout | Medium | Medium | Add `AUDIO_TIMEOUT_MS` constant; benchmark on a representative folder in dev; raise crontab `--max-time` proactively. |
| Drive API rate limits with both syncs in same window | Low | Medium | Sequential ordering already reduces this; both use the same retry-on-5xx wrapper from `14770e7`. |
| Shared `BatchEditDialog` becomes a god-component as audio + CT diverge | Medium | Medium | Keep dialog dumb — pass `fields` schema + `onSubmit` callback; resist adding conditionals on `module` prop. If divergence appears, fork. |
| `audioFiles` soft-delete logic in `scanDeploymentAudioInternal` differs from CT's image handling | High | Low | Already-known difference; document in `audio-sync-internals.ts` header comment. |

## Resource Requirements

- One engineer (probably you); ~3–5 days of focused work, split across 6 phases.
- No infra changes. No new env vars beyond optional `AUDIO_SYNC_CONCURRENCY` (defaults to `DRIVE_SYNC_CONCURRENCY`).
- No new dependencies.

## Future Considerations

- The pattern established here (`drive-sync-worker-core` + per-module scanner) generalises to a third module if/when iButton gets a Drive-sync flow. The audio implementation should be referenceable as "do it like this."
- If batch actions on audio prove popular, the same `BatchEditDialog` can serve a future `/biochoco` deployments list.
- Consider, after this lands, a small `docs/solutions/` entry capturing "how to add a third module to nightly-refresh" — feeds future Claude/team work.

## Documentation Plan

- Update `CLAUDE.md` "Architecture" section briefly: "Drive sync uses a generic worker (`src/lib/drive-sync-worker-core.ts`) with per-module scanners. To add a third module: implement `listDeployments` + `scanOne` and register in `nightly-refresh`."
- Add `docs/solutions/integration-issues/audio-drive-sync-pattern.md` if any non-obvious gotchas come up during implementation.
- Memory candidate: capture the "shared primitives over generic component" pattern as a feedback memory if reviewers push back on either extreme.

## References & Research

### Internal References — Camera-Trap (source of truth)

- Sync worker: `src/lib/camera-trap-sync-worker.ts` (on `main`, lines 95–402)
- Sync internals: `src/lib/camera-trap-sync-internals.ts` (`scanDeploymentImagesInternal`, `refreshUploadCountsInternal`, `matchOdkDeploymentsInternal`)
- Drive actions: `src/app/camera-trap/drive-actions.ts:44` (`enqueueDriveSyncJob`)
- Table with selection: `src/app/camera-trap/deployments-table.tsx:88-266` (state + select column)
- Range-selection refs pattern: `deployments-table.tsx:101-107` on `main`
- Group-collapse persistence: `deployments-table.tsx:62-82` (localStorage hydration pattern)
- Nightly cron: `src/app/api/cron/nightly-refresh/route.ts` on `main`
- Batch dialogs: `src/app/camera-trap/batch-edit-dialog.tsx`, `batch-delete-dialog.tsx`

### Internal References — Audio (current state)

- Page shell: `src/app/audio/audio-deployments-shell.tsx` (449 lines, no selection)
- Actions: `src/app/audio/actions.ts:273` (`scanDeploymentAudio`), `:403` (`scanAllAudio` to be retired)
- Schema: `src/db/schema.ts` — `audioFiles`, `audioDetections`, `audioIdentifications`, `deployments.uploadAudioFolderId`
- BirdNET job pattern: `actions.ts:441` (`createBirdNETJob`) — analogue for `enqueueAudioSyncJob`
- Audio cache helpers: `src/lib/audio-cache.ts`

### Related Plans

- `docs/plans/2026-05-06-feat-drive-sync-background-parallel-nightly-plan.md` — the camera-trap version of this work. Read first.
- `docs/plans/2026-05-10-refactor-audio-annotation-ux-parity-plan.md` — analogous pattern for annotation chrome.

### Related Commits (on main)

- `5381c11` per-group select-all + shift+click row range selection
- `152186b` default sort deployments by name within each group
- `600f270` drive sync background worker with parallel fan-out
- `102bd6f` rewrite nightly cron to use drive_sync worker
- `11238d5` switch sync UI to background job + split-button picker
- `850cccb` drive sync progress counter stuck at 1 (bugfix to be aware of)
- `024a6ae` migrations for drive_sync schema changes
- `4d2f71d` per-installation deltas in nightly email (delta-reporting pattern)

### Institutional Learnings to Apply

- `docs/solutions/runtime-errors/async-transaction-better-sqlite3-CameraTrap-20260223.md` — keep transactions synchronous (already an issue in audio scan logic; preserve when extracting to internals).
- Memory: "Drizzle sql template + undefined" — `??  null` for optional Drive fields when upserting `audioFiles`.
- Memory: "better-sqlite3 transactions are synchronous" — `db.transaction()` callback must not be async; current `scanDeploymentAudio` already follows this.
- Memory: "Server→Client serialization" — when passing deployment data into client components, pass strings, not Date objects (audio shell already does this correctly).

## Implementation Phases (TL;DR)

| Phase | Scope | PR size | Depends on |
|---|---|---|---|
| 0 | Merge `feat/birdnet-audio-analysis` to main; cut new branch | small | — |
| 1 | Extract shared primitives (selection hook, worker core, dialogs) | medium | 0 |
| 2 | Audio sync worker + `enqueueAudioSyncJob` | medium | 1 |
| 3 | Port audio table UI (sort, checkbox, split-button) | medium | 1, 2 |
| 4 | Wire audio sync into nightly cron + email | small | 2 |
| 5 | Audio batch actions (edit, BirdNET, re-scan, clear-index) | medium | 1, 3 |
| 6 | Tests + verification | small-medium | all above |
