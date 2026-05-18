---
title: feat: Cronograma in-row schedule editor (swap dates + direct date edit)
type: feat
date: 2026-05-18
status: implemented
related_brainstorm: docs/brainstorms/2026-05-18-cronograma-in-row-editor-brainstorm.md
revision: 2 (incorporates DHH / Kieran / Simplicity review feedback)
---

# feat: Cronograma in-row schedule editor (Biochoco)

## Overview

Add a per-row **Editar** action to the Biochoco cronograma at `/biochoco` that opens a modal Dialog and lets editors either (1) **swap dates** with another scheduled deployment — same-habitat candidates first to preserve stratified sampling — or (2) **change the fecha-plan** directly with the planned retrieve date auto-shifting by the same interval. Persistence flows through the existing Google Sheets-backed schedule using per-row writes (`updateScheduleRows`). Swap uses a preview→hash→commit pattern; direct date edit is a one-shot commit (per-row writes already isolate the change). Every successful mutation emits a `recordEvent` audit entry.

The standalone `Tools → Intercambiar Fechas` page is **kept untouched in v1** as a safety net.

## Problem Statement / Motivation

Karla (Biochoco station manager) needs to rearrange June 2026 installations to fit student availability. Today she'd have to:

1. Leave the cronograma view.
2. Open `/biochoco/tools` (admin-only — she can't).
3. Pick two deployments from an unfiltered dropdown listing every scheduled row by ID — no habitat awareness.
4. Repeat per swap.

The new editor puts the action on the row she's already looking at, surfaces same-habitat candidates by default, and opens it up to the `editor` role so station managers can self-serve.

## Proposed Solution

### Where

- **Cronograma table** (`src/app/biochoco/overview/schedule-table.tsx`): add an `Editar` action column. Button renders only when `row.status === "scheduled"` and `canEditSchedule` is true.
- **New Dialog component** (`src/app/biochoco/overview/inline-schedule-editor-dialog.tsx`): Client Component using `@/components/ui/dialog`.
- **New server actions** (`src/app/biochoco/overview/actions.ts`): `previewInlineSwap`, `commitInlineSwap`, `commitDateEdit`. All call `requirePermission("biochoco", "editor")`.
- **Shared hash helper** (new `src/lib/schedule-hash.ts`): extracted from `tools/actions.ts:25-28` so both `tools/actions.ts` (existing) and the new `overview/actions.ts` can use it without duplication.
- **Tighter type** in `src/lib/schedule-types.ts`: narrow `ScheduleRowUpdate.fields` to known column keys (see Phase 0).
- **New event source** in `src/db/schema.ts:498-508`: add `"biochoco-overview"` to the `EVENT_SOURCES` enum (the new actions don't live under `/tools`).
- **New pure helper** in `src/lib/schedule-utils.ts`: `editDeploymentDate(rows, deploymentId, newDeployDate)` — returns `{ rows, changes }`.

### Dialog UX (one modal, two co-visible sections)

```
+--------------------------------------------------------+
| Editar SEC-009 — Bosque Secundario                  ✕  |
|--------------------------------------------------------|
| Fechas actuales:  Instalación 12/6/2026                |
|                   Recuperación 12/7/2026               |
|                                                        |
| ───── Cambiar fecha ─────                              |
| Nueva fecha de instalación: [ 12/06/2026 ]             |
| Recuperación se moverá a 17/7/2026.                    |
| [ Aplicar cambio de fecha ]                            |
|                                                        |
| ───── ó intercambiar con otra instalación ─────        |
| [✔] Solo mismo hábitat (Bosque Secundario)             |
| [Buscar... 🔍]                                          |
| ○ SEC-013 — 17/6/2026                                  |
| ○ SEC-015 — 18/6/2026                                  |
| ... (scrollable, max-h-64)                             |
| [ Vista previa del intercambio ]                       |
|--------------------------------------------------------|
| Preview (swap only)                                    |
|   SEC-009  plannedDeployDate  12/6/2026 → 17/6/2026    |
|   SEC-013  plannedDeployDate  17/6/2026 → 12/6/2026    |
|   ⚠ validateSchedule warnings (if any, yellow)         |
| [ Aplicar intercambio ]                                |
+--------------------------------------------------------+
```

**Direct date edit** is one-shot: the dialog computes the new retrieve date client-side from the existing interval (cheap, deterministic) and shows it inline. Clicking "Aplicar cambio de fecha" calls `commitDateEdit` once; the server validates, writes, records the event, and returns either `{success: true, data: { warnings }}` or `{success: false, error}`. Any `validateSchedule` warnings surface as a yellow note above the success message.

**Swap** keeps the preview/commit two-step because the change set is non-obvious and operates on two rows.

### Persistence model

- Reuse `loadSchedule()` + the extracted `scheduleHash()`. **Swap**: preview returns the hash; commit re-loads, recomputes, rejects on mismatch. **Date edit**: no hash — `updateScheduleRows` per-row writes already mean a single-row change can't clobber other rows; the only "race" is two editors changing the same row in the same ~2s, where last-write-wins is acceptable Sheets semantics.
- Both actions use `updateScheduleRows` (not `saveSchedule`). Touched rows only. Untouched rows are not rewritten.
- Both actions explicitly include `plannedDeployDate, plannedRetrieveDate, deploySlotId, retrieveSlotId, season` in the partial update.
- Slot IDs are cleared on direct edit. Slot IDs are swapped on swap (existing `swapDeploymentDates` behavior).

### Refresh after commit

`revalidatePath("/biochoco")` from the server action invalidates the RSC cache. The dialog then **closes synchronously on success** and immediately calls `router.refresh()` from `next/navigation`. Closing first avoids the unmounted-component warning that a `setTimeout` close would risk. The parent page re-renders, the prop tree flows down, and the table reflects new dates without a manual reload.

## Technical Considerations

- **Server-side re-verification** (per `docs/solutions/security-issues/phase2-code-review-12-findings.md` P1-3): client submits only IDs and the date string. Server re-loads, re-derives, validates, writes.
- **Date format guard**: every action that takes a date string runs `if (!/^\d{4}-\d{2}-\d{2}$/.test(newDeployDate)) return { success: false, error: "Fecha inválida." }` as the first guard. The `<input type="date">` won't normally emit anything else, but actions are reachable directly.
- **Error localization at the action boundary**: `swapDeploymentDates` throws English (`"Deployment X not found"`). Wrap action bodies in `try/catch` and map known Errors to Spanish via `ActionResult`. Match the pattern already in `tools/actions.ts:86-88`.
- **Validation**: `validateSchedule(updatedRows)` runs server-side. Errors are returned alongside the change set and rendered as yellow warnings (matches `bulk-shift` UI). **Warnings do not block commit** — same as existing pattern.
- **Season recalc**: handled inside `editDeploymentDate` / `swapDeploymentDates`. Surfaced in the swap preview only as one row of the change table — no separate "season changed" callout (DHH/Simplicity review: the wet_transition → wet_transition case fires spuriously).

### Architecture (sequence)

```
User clicks Editar on row
  → Dialog opens, props include self (ScheduleRow) and candidates (ScheduleRow[])
       (no async fetch — already loaded server-side for the table)

   Path A: Swap
     → User picks target → "Vista previa del intercambio" → previewInlineSwap
         (server: loadSchedule → swapDeploymentDates → validateSchedule → return changes+hash)
     → Preview renders
     → "Aplicar intercambio" → commitInlineSwap(id1, id2, hash)
         (server: loadSchedule → hash check → swapDeploymentDates → updateScheduleRows([2 rows]) → recordEvent)

   Path B: Direct edit
     → User picks date → "Aplicar cambio de fecha" → commitDateEdit(deploymentId, newDate)
         (server: loadSchedule → editDeploymentDate → validateSchedule → updateScheduleRows([1 row]) → recordEvent → return warnings)

   On success:
     → Dialog closes synchronously
     → router.refresh()
     → Table re-renders with new dates
```

### Permissions

- New server actions: `requirePermission("biochoco", "editor")`.
- `Editar` button renders only when `canEditSchedule` is true. Computed in `overview/page.tsx` (Server Component) like the existing `canEditNotes`, threaded through `DashboardShell` → `ScheduleTable`.
- Existing standalone `Tools → Intercambiar Fechas` stays admin-only in v1 (intentional asymmetry; revisit in v2). To avoid the "different ACL emits same event source" smell, the new actions use `source: "biochoco-overview"` (new enum value); the old Tools actions keep `source: "biochoco-tools"`. Activity feed can filter cleanly.

## Acceptance Criteria

### Functional

- [x] `Editar` button appears on each row where `row.status === "scheduled"` AND `canEditSchedule === true`. Hidden otherwise.
- [x] Dialog shows current planned deploy and retrieve dates as read-only context at the top.
- [x] **Swap section**: candidate list defaults to same `habitatType`, excludes self. Toggle "Solo mismo hábitat" off to show all scheduled rows. Text filter narrows by `deploymentId` or `siteName`.
- [x] **Date edit section**: `<Input type="date" min={todayISO}>`, default value = current `plannedDeployDate`. Below the input, a live-computed line reads "Recuperación se moverá a YYYY-MM-DD." based on the current interval.
- [x] Clicking "Vista previa del intercambio" renders the change-set table + validation warnings. Clicking "Aplicar intercambio" calls `commitInlineSwap` with the hash.
- [x] Clicking "Aplicar cambio de fecha" calls `commitDateEdit` directly (no preview step). On success, any validation warnings appear briefly inline before the dialog closes.
- [x] On any successful commit, the dialog closes synchronously, then `router.refresh()` fires, and the table reflects new dates within ~2s without a manual reload.
- [x] Hash mismatch on swap returns Spanish error `"El cronograma fue modificado por otro usuario. Reintenta la vista previa."` — the user clicks the existing "Vista previa del intercambio" button to retry (no separate retry button).

### Permissions / Auth

- [x] All three new server actions call `requirePermission("biochoco", "editor")` as the first line.
- [x] A user with role `visor` invoking the action directly receives an auth error (action-layer enforcement, not just UI hiding).

### Persistence & Telemetry

- [x] Both new actions write via `updateScheduleRows` (not `saveSchedule`). Verified by inspecting Sheet revision history.
- [x] `updateScheduleRows` partial update explicitly includes `plannedDeployDate, plannedRetrieveDate, deploySlotId, retrieveSlotId, season`.
- [x] `ScheduleRowUpdate.fields` is typed against `keyof ScheduleRow` (or a narrow union of writable column keys), so a typo like `plannedDeployDay` fails at compile time.
- [x] `schedule_inline_swap` and `schedule_date_edit` events are emitted with `source: "biochoco-overview"` and the full `details` schema (below).
- [x] `"biochoco-overview"` is registered in the `EVENT_SOURCES` enum in `src/db/schema.ts`.

### Testing

- [x] Unit tests for `editDeploymentDate` (factory pattern, season recalc, slot clear, interval preserved, null retrieve, immutability of input rows).
- [x] Action-layer tests for permission gating, hash mismatch (swap only), malformed date string rejection, and the `id1 === id2` self-swap guard.
- [ ] Manual QA checklist (below) passes.

## Implementation Phases

### Phase 0 — Shared prerequisites

Small but load-bearing groundwork — do these first so subsequent phases are clean.

#### `src/lib/schedule-hash.ts` (new)

```ts
import { createHash } from "crypto";
import type { ScheduleRow } from "@/lib/schedule-types";

export function scheduleHash(rows: ScheduleRow[]): string {
  const content = JSON.stringify(
    rows.map((r) => [r.deploymentId, r.status, r.plannedDeployDate, r.plannedRetrieveDate]),
  );
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
```

Update `src/app/biochoco/tools/actions.ts` to import from `@/lib/schedule-hash` (delete the local copy at lines 25-28). Pure refactor; existing behavior unchanged.

#### `src/lib/schedule-types.ts` (edit)

```ts
// Narrow writable column keys explicitly so updateScheduleRows can't silently no-op typos.
export type WritableScheduleField =
  | "plannedDeployDate"
  | "plannedRetrieveDate"
  | "actualDeployDate"
  | "actualRetrieveDate"
  | "deploySlotId"
  | "retrieveSlotId"
  | "season"
  | "status";

export interface ScheduleRowUpdate {
  deploymentId: string;
  fields: Partial<Record<WritableScheduleField, string | number | null>>;
}
```

This will surface any existing callers passing untyped strings — fix them in the same change (likely `commitSyncOdk` in `tools/actions.ts`, which already uses the right keys but with `string` typing).

#### `src/db/schema.ts:498-508` (edit)

Add `"biochoco-overview"` to `EVENT_SOURCES`. Run schema push: `node scripts/push-schema.mjs` (locally). The column is a free-form text column — additive change, no migration risk.

### Phase 1 — Pure logic + tests

#### `src/lib/schedule-utils.ts` (add)

```ts
// after swapDeploymentDates
export function editDeploymentDate(
  rows: ScheduleRow[],
  deploymentId: string,
  newDeployDate: string, // "YYYY-MM-DD" — caller is responsible for format
): { rows: ScheduleRow[]; changes: ScheduleChange[] } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newDeployDate)) {
    throw new Error(`Invalid date format: ${newDeployDate}`);
  }
  const idx = rows.findIndex((r) => r.deploymentId === deploymentId);
  if (idx === -1) throw new Error(`Deployment ${deploymentId} not found`);
  const row = rows[idx];
  if (row.status !== "scheduled") throw new Error(`${deploymentId} is not scheduled`);
  if (!row.plannedDeployDate) throw new Error(`${deploymentId} has no current planned deploy date`);

  const oldDeploy = parseDate(row.plannedDeployDate);
  const newDeploy = parseDate(newDeployDate);
  const intervalMs = row.plannedRetrieveDate
    ? parseDate(row.plannedRetrieveDate).getTime() - oldDeploy.getTime()
    : 0;
  const newRetrieve = row.plannedRetrieveDate
    ? new Date(newDeploy.getTime() + intervalMs)
    : null;
  const newSeason = assignSeason(newDeploy);

  const updated: ScheduleRow = {
    ...row,
    plannedDeployDate: newDeployDate,
    plannedRetrieveDate: newRetrieve ? dateStr(newRetrieve) : row.plannedRetrieveDate,
    deploySlotId: null,
    retrieveSlotId: null,
    season: newSeason,
  };

  const changes: ScheduleChange[] = [];
  const pushChange = (field: keyof ScheduleRow, oldV: unknown, newV: unknown) => {
    const a = String(oldV ?? "N/A");
    const b = String(newV ?? "N/A");
    if (a !== b) changes.push({ deploymentId, field, oldValue: a, newValue: b });
  };
  pushChange("plannedDeployDate", row.plannedDeployDate, updated.plannedDeployDate);
  pushChange("plannedRetrieveDate", row.plannedRetrieveDate, updated.plannedRetrieveDate);
  pushChange("deploySlotId", row.deploySlotId, updated.deploySlotId);
  pushChange("retrieveSlotId", row.retrieveSlotId, updated.retrieveSlotId);
  pushChange("season", row.season, updated.season);

  const result = [...rows];
  result[idx] = updated;
  return { rows: result, changes };
}
```

Also add a small guard to `swapDeploymentDates`: if `id1 === id2`, throw `"Cannot swap a deployment with itself"`. Caught by the action wrapper and surfaced in Spanish.

#### `tests/unit/schedule-utils.test.ts` (add)

New `describe("editDeploymentDate")` block. Cases:
- shifts both dates by the same interval (30 days)
- preserves the deploy↔retrieve interval exactly
- recalculates season when crossing a season boundary
- clears `deploySlotId` and `retrieveSlotId`
- leaves `plannedRetrieveDate` null if the source row's retrieve is null
- throws on malformed date string (`"06/12/2026"`, `""`, `"2026-13-01"`)
- throws on unknown ID; throws on non-scheduled status
- does NOT mutate the input `rows` array (assert via deep equality before/after)
- emits change records only for fields that actually changed

Plus one new case for `swapDeploymentDates`: `throws "Cannot swap a deployment with itself"` when id1 === id2.

### Phase 2 — Server actions

#### `src/app/biochoco/overview/actions.ts` (new)

```ts
"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth";
import { loadSchedule, updateScheduleRows } from "@/lib/sheets-client";
import { swapDeploymentDates, editDeploymentDate, validateSchedule } from "@/lib/schedule-utils";
import { scheduleHash } from "@/lib/schedule-hash";
import { recordEvent } from "@/lib/system-events";
import type { ActionResult } from "@/lib/types";
import type { ScheduleChange } from "@/lib/schedule-types";

export interface InlineSwapPreview {
  changes: ScheduleChange[];
  validationErrors: string[];
  hash: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function wrapAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  return fn()
    .then((data) => ({ success: true as const, data }))
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : "Error desconocido";
      // Localize common English errors thrown by schedule-utils.
      const localized =
        msg.includes("not found") ? "Instalación no encontrada."
        : msg.includes("not scheduled") ? "Esta instalación no está programada."
        : msg.includes("Cannot swap a deployment with itself") ? "No se puede intercambiar una instalación consigo misma."
        : msg.includes("Invalid date format") ? "Fecha inválida."
        : msg.includes("no current planned deploy date") ? "La instalación no tiene fecha planificada."
        : msg;
      return { success: false as const, error: localized };
    });
}

export async function previewInlineSwap(id1: string, id2: string) {
  return wrapAction<InlineSwapPreview>(async () => {
    await requirePermission("biochoco", "editor");
    const schedule = await loadSchedule();
    const { rows: updatedRows, changes } = swapDeploymentDates(schedule, id1, id2);
    return { changes, validationErrors: validateSchedule(updatedRows), hash: scheduleHash(schedule) };
  });
}

export async function commitInlineSwap(id1: string, id2: string, expectedHash: string) {
  return wrapAction<void>(async () => {
    const user = await requirePermission("biochoco", "editor");
    const schedule = await loadSchedule();
    if (scheduleHash(schedule) !== expectedHash) {
      throw new Error("El cronograma fue modificado por otro usuario. Reintenta la vista previa.");
    }
    const before1 = schedule.find((r) => r.deploymentId === id1)!;
    const before2 = schedule.find((r) => r.deploymentId === id2)!;
    const { rows: updatedRows } = swapDeploymentDates(schedule, id1, id2);
    const after1 = updatedRows.find((r) => r.deploymentId === id1)!;
    const after2 = updatedRows.find((r) => r.deploymentId === id2)!;

    await updateScheduleRows([
      { deploymentId: id1, fields: {
        plannedDeployDate: after1.plannedDeployDate,
        plannedRetrieveDate: after1.plannedRetrieveDate,
        deploySlotId: after1.deploySlotId,
        retrieveSlotId: after1.retrieveSlotId,
        season: after1.season,
      }},
      { deploymentId: id2, fields: {
        plannedDeployDate: after2.plannedDeployDate,
        plannedRetrieveDate: after2.plannedRetrieveDate,
        deploySlotId: after2.deploySlotId,
        retrieveSlotId: after2.retrieveSlotId,
        season: after2.season,
      }},
    ]);

    await recordEvent({
      source: "biochoco-overview",
      eventType: "schedule_inline_swap",
      summary: `Fechas intercambiadas en cronograma: ${id1} ↔ ${id2}`,
      actorEmail: user.email,
      projectId: "biochoco",
      targetType: "schedule",
      targetId: id1,
      details: {
        id1, id2,
        beforeDate1: before1.plannedDeployDate, afterDate1: after1.plannedDeployDate,
        beforeDate2: before2.plannedDeployDate, afterDate2: after2.plannedDeployDate,
        habitatType1: after1.habitatType, habitatType2: after2.habitatType,
      },
    });

    revalidatePath("/biochoco");
  });
}

export async function commitDateEdit(deploymentId: string, newDeployDate: string) {
  return wrapAction<{ warnings: string[] }>(async () => {
    const user = await requirePermission("biochoco", "editor");
    if (!ISO_DATE.test(newDeployDate)) throw new Error("Invalid date format");
    const schedule = await loadSchedule();
    const before = schedule.find((r) => r.deploymentId === deploymentId);
    if (!before) throw new Error("Deployment not found");

    const { rows: updatedRows } = editDeploymentDate(schedule, deploymentId, newDeployDate);
    const after = updatedRows.find((r) => r.deploymentId === deploymentId)!;
    const warnings = validateSchedule(updatedRows);

    await updateScheduleRows([{
      deploymentId,
      fields: {
        plannedDeployDate: after.plannedDeployDate,
        plannedRetrieveDate: after.plannedRetrieveDate,
        deploySlotId: null,
        retrieveSlotId: null,
        season: after.season,
      },
    }]);

    await recordEvent({
      source: "biochoco-overview",
      eventType: "schedule_date_edit",
      summary: `Fecha-plan editada para ${deploymentId}: ${before.plannedDeployDate} → ${after.plannedDeployDate}`,
      actorEmail: user.email,
      projectId: "biochoco",
      targetType: "schedule",
      targetId: deploymentId,
      details: {
        deploymentId,
        oldDeployDate: before.plannedDeployDate, newDeployDate: after.plannedDeployDate,
        oldRetrieveDate: before.plannedRetrieveDate, newRetrieveDate: after.plannedRetrieveDate,
        slotsCleared: before.deploySlotId !== null || before.retrieveSlotId !== null,
      },
    });

    revalidatePath("/biochoco");
    return { warnings };
  });
}
```

### Phase 3 — Dialog component

#### `src/app/biochoco/overview/inline-schedule-editor-dialog.tsx` (new, Client Component)

Props (candidates passed in — no async fetch on open):

```ts
interface InlineScheduleEditorDialogProps {
  self: ScheduleRow;
  candidates: ScheduleRow[]; // all other scheduled rows
  open: boolean;
  onOpenChange: (open: boolean) => void;
}
```

State (discriminated union to keep `preview` properly narrowed):

```ts
type DialogState =
  | { mode: "idle" }
  | { mode: "swap-preview"; preview: InlineSwapPreview };

const [state, setState] = useState<DialogState>({ mode: "idle" });
const [dateInput, setDateInput] = useState(self.plannedDeployDate ?? "");
const [selectedSwapId, setSelectedSwapId] = useState<string | null>(null);
const [habitatOnly, setHabitatOnly] = useState(true);
const [candidateFilter, setCandidateFilter] = useState("");
const [error, setError] = useState<string | null>(null);
const [warnings, setWarnings] = useState<string[]>([]);
const [isPending, startTransition] = useTransition();
const router = useRouter();
```

`mode` is derivable from `selectedSwapId`/`dateInput` only after a successful preview/commit — store explicitly only when a preview has happened.

Filtered candidates (memoized to avoid re-filtering on every keystroke):

```ts
const filtered = useMemo(() => {
  const q = candidateFilter.toLowerCase();
  return candidates.filter((c) => {
    if (habitatOnly && c.habitatType !== self.habitatType) return false;
    if (q && !c.deploymentId.toLowerCase().includes(q) && !c.siteName.toLowerCase().includes(q)) return false;
    return true;
  });
}, [candidates, habitatOnly, candidateFilter, self.habitatType]);
```

Live retrieve-date preview (client-side):

```ts
const newRetrievePreview = useMemo(() => {
  if (!dateInput || !self.plannedDeployDate || !self.plannedRetrieveDate) return null;
  const interval = parseDate(self.plannedRetrieveDate).getTime() - parseDate(self.plannedDeployDate).getTime();
  return dateStr(new Date(parseDate(dateInput).getTime() + interval));
}, [dateInput, self.plannedDeployDate, self.plannedRetrieveDate]);
```

Handlers:

```ts
function handlePreviewSwap() {
  if (!selectedSwapId) return;
  setError(null);
  startTransition(async () => {
    const result = await previewInlineSwap(self.deploymentId, selectedSwapId);
    if (result.success) setState({ mode: "swap-preview", preview: result.data });
    else setError(result.error);
  });
}

function handleCommitSwap() {
  if (state.mode !== "swap-preview") return;
  setError(null);
  startTransition(async () => {
    const result = await commitInlineSwap(self.deploymentId, selectedSwapId!, state.preview.hash);
    if (result.success) handleSuccess();
    else setError(result.error);
  });
}

function handleCommitDateEdit() {
  if (!dateInput || dateInput === self.plannedDeployDate) return;
  setError(null);
  startTransition(async () => {
    const result = await commitDateEdit(self.deploymentId, dateInput);
    if (result.success) {
      setWarnings(result.data.warnings);
      handleSuccess();
    } else {
      setError(result.error);
    }
  });
}

function handleSuccess() {
  onOpenChange(false);  // close synchronously — no setTimeout, no unmount race
  router.refresh();
}
```

Styling matches `bulk-shift.tsx`: yellow warnings, destructive errors, `"Calculando..." / "Guardando..."` button labels. Date input uses `min={todayISO}`. No "Reintentar vista previa" button — on hash mismatch, the user clicks the existing "Vista previa del intercambio" button again.

#### `src/app/biochoco/overview/schedule-table.tsx` (edit)

Add prop `canEditSchedule?: boolean`. Add a final column:

```tsx
{
  id: "edit",
  header: "",
  cell: ({ row }) => {
    if (!canEditSchedule) return null;
    if (row.original.status !== "scheduled") return null;
    return <EditScheduleButton row={row.original} schedule={allSchedule} />;
  },
  enableSorting: false,
  enableGlobalFilter: false,
}
```

`EditScheduleButton` is a small wrapper that owns `useState(open)`, derives `self` and `candidates` from the passed-in `allSchedule` (already a prop on `ScheduleTable`), and renders the Dialog. No new server calls on dialog open.

#### `src/app/biochoco/overview/dashboard-shell.tsx` (edit)

Accept `canEditSchedule?: boolean` prop, pass through to `ScheduleTable`.

#### `src/app/biochoco/overview/page.tsx` (edit)

```ts
const role = user?.projectRoles?.biochoco;
const canEditSchedule = role === "editor" || role === "admin";
return <DashboardShell data={...} canEditNotes={canEditNotes} canEditSchedule={canEditSchedule} />;
```

### Phase 4 — Tests & manual QA

#### Unit (Vitest)

`tests/unit/schedule-utils.test.ts`: new `describe("editDeploymentDate")` per Phase 1; one new case for `swapDeploymentDates` (`id1 === id2`).

#### Action-layer tests (Vitest)

`tests/integration/biochoco-inline-editor-actions.test.ts` (new):

- `previewInlineSwap` / `commitInlineSwap` / `commitDateEdit` all reject `visor`-role callers (auth error)
- `commitInlineSwap` returns `"El cronograma fue modificado…"` on hash mismatch
- `commitInlineSwap` rejects `id1 === id2` with Spanish error
- `commitDateEdit` rejects malformed date string (`"06/12/2026"`, `""`)
- `commitDateEdit` emits exactly one `schedule_date_edit` event with the right `details.slotsCleared` value
- `updateScheduleRows` is called with exactly the expected partial-update shape (mock and assert call signature includes only the 5 writable fields)

#### Manual QA checklist

- [ ] As `editor`: swap two same-habitat rows → table refreshes without reload, sheet revision history shows only the 2 rows updated.
- [ ] As `editor`: edit a row's date by +5 days → retrieve moves +5 days, slot IDs cleared (verify in sheet).
- [ ] As `visor`: `Editar` button is hidden.
- [ ] Open dialog in two tabs, commit swap in tab 1, click "Aplicar intercambio" in tab 2 → see hash-mismatch error, click "Vista previa del intercambio" again → fresh preview against current sheet state.
- [ ] Verify `system_events` shows `source: "biochoco-overview"` with the new event types.
- [ ] Mobile: dialog scrolls, date picker is usable.

## Success Metrics

- Karla and other station managers (now `editor` role) can rearrange ~8 swaps a month from a single screen.
- Zero "I overwrote someone else's edit" incidents (per-row writes + hash on swap).
- `schedule_inline_swap` / `schedule_date_edit` events appear in the activity feed for every commit.
- Standalone `Tools → Intercambiar Fechas` usage drops near zero within 30 days → signal to deprecate in v2.

## Dependencies & Risks

- **No new dependencies.** Reuses `Dialog`, `Input`, `useTransition`, `useRouter`, `loadSchedule`, `updateScheduleRows`, `swapDeploymentDates`, `validateSchedule`, `recordEvent`, `requirePermission`.
- **Risk: standalone Tools page still uses `saveSchedule` (full rewrite).** A bulk shift in Tools could clobber an in-row swap. Mitigation: hash check on the bulk-shift commit will catch it; UX of "your shift was rejected" is poor but recoverable. Not fixing in v1; flag as known limitation.
- **Risk: opening up to `editor`.** Today `editor` can edit field notes / share links. Schedule mutations are a real expansion. Mitigation: `recordEvent` on every commit; hash + per-row writes; easy rollback by tightening the `requirePermission` calls.
- **Risk: slot template drift.** Each direct edit clears slot IDs for one deployment. Over time the slot template gets less meaningful. Out of scope for v1; if it matters, add a future task to regenerate slot assignments.
- **Risk: `router.refresh()` re-runs ODK status derivation in the page-level RSC.** Acceptable for v1 (<2s typically). Revisit if slow.

## Open Questions (deferred)

- Retrieve-only edit for already-deployed deployments (separate flow; v2).
- Field-crew notification on date changes (manual today).
- Visit-number ordering enforcement (V1 < V2 < V3 chronologically) — neither swap nor edit guards this; defer.
- Monthly cap enforcement on direct edit (`MAX_DEPLOYS_PER_MONTH`) — `validateSchedule` doesn't check; out of scope.
- Deprecating standalone Tools swap UI once in-row usage is established.

## References & Research

### Internal references

- Brainstorm: `docs/brainstorms/2026-05-18-cronograma-in-row-editor-brainstorm.md`
- Cronograma: `src/app/biochoco/overview/schedule-table.tsx`, `dashboard-shell.tsx`, `page.tsx`
- Existing date-swap UI to mirror: `src/app/biochoco/tools/date-swap.tsx`, `bulk-shift.tsx`, `add-site.tsx`
- Existing tools actions: `src/app/biochoco/tools/actions.ts:163-212` (preview/commit pattern), `:25-28` (hash to extract)
- Pure helpers to extend: `src/lib/schedule-utils.ts:286` (`swapDeploymentDates`), `:105` (`assignSeason`)
- Types to tighten: `src/lib/schedule-types.ts:50-53` (`ScheduleRowUpdate.fields`)
- Sheets I/O: `src/lib/sheets-client.ts:108` (`loadSchedule`), `:176` (`updateScheduleRows`), `:206-209` (silent skip on unknown column — fixed by Phase 0 tightening)
- Event source enum: `src/db/schema.ts:498-508` (`EVENT_SOURCES`)
- Dialog primitive: `src/components/ui/dialog.tsx`; examples in `src/app/camera-trap/delete-confirm-dialog.tsx`, `src/components/deployments/batch-edit-dialog.tsx`
- Permissions: `src/lib/auth.ts`; canEditNotes example at `src/app/biochoco/overview/page.tsx:24-28`
- Event logging: `src/lib/system-events.ts`; existing call sites in `tools/actions.ts:144-152, 197-205, 274-283`
- Test patterns: `tests/unit/schedule-utils.test.ts:14-32` (factory), `:170-210` (swap tests)

### Institutional learnings (`docs/solutions/`)

- `security-issues/phase2-code-review-12-findings.md` — write-then-clear, server-side re-verification, hash-based optimistic locking, ActionResult<T> usage. **All apply.**

### CLAUDE.md conventions

- Spanish UI strings; `ActionResult<T>`; `requirePermission()` on every action; `recordEvent()` for admin-facing mutations; tables sortable by default with shared `SortIcon`; per-row writes via `updateScheduleRows` keep the write-then-clear safety guarantee.

## Review feedback applied (revision 2)

This revision incorporates DHH / Kieran / Simplicity review:

- **Cut**: `fetchSwapCandidates` server action (candidates now passed as Dialog props from the table's existing schedule prop).
- **Cut**: `previewDateEdit` action and `InlineDateEditPreview` type — direct edit is one-shot.
- **Cut**: hash check on direct date edit (per-row writes already isolate the change).
- **Cut**: season-change preview callouts (spurious noise; the season change already appears in the change-set table).
- **Cut**: "Reintentar vista previa" button (the existing preview button does the same job).
- **Added (Phase 0)**: extract `scheduleHash` to `src/lib/schedule-hash.ts`; tighten `ScheduleRowUpdate.fields` to a `WritableScheduleField` union; add `"biochoco-overview"` to `EVENT_SOURCES`.
- **Added**: Spanish error wrapping at the action boundary (`wrapAction`) so `swapDeploymentDates`'s English `Error`s don't leak to UI.
- **Added**: discriminated union for dialog state so `preview` narrows correctly.
- **Added**: explicit `id1 === id2` guard in `swapDeploymentDates` + tests; date-format guard in actions and helpers + tests.
- **Fixed**: dialog closes synchronously on success then calls `router.refresh()` (no `setTimeout` close — avoids unmount race).
- **Fixed**: candidate filter wrapped in `useMemo` to avoid re-filtering the full list on every keystroke.
