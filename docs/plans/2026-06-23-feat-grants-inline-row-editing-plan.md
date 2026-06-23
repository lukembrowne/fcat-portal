---
title: "feat: Inline row editing for the grants table (live editable cells)"
type: feat
date: 2026-06-23
status: planned
related:
  - docs/plans/2026-06-22-feat-grant-tracking-module-plan.md
  - docs/plans/2026-05-18-feat-cronograma-in-row-editor-plan.md (in-row editor precedent)
---

# feat: Inline row editing for the grants table ✨

## Overview

Make every displayed column of the `/grants` table **editable in place**, so collaborators can update a
grant's status, amounts, dates, notify window, links, funder, and notes without clicking through to the
grant detail page. The chosen interaction model is **live editable cells** (a spreadsheet feel): a cell
shows its formatted value (badge, `$50,000`, `Aug 1, 2026`); clicking it (when you're an editor) swaps to
the right input; **blur or Enter saves**, **Escape reverts**. Each save is a single per-field write through a
new `updateGrantField` server action, with an optimistic in-cell update and a `router.refresh()` to re-sync
derived UI (summary cards, urgency badge).

This is a UI + one-new-action change. **No schema/migration changes** — all target columns already exist on
the `grants` table. It builds directly on the existing admin "live `<Select>` in a cell" pattern and reuses
the grant module's coercion/validation helpers and `recordEvent` audit trail.

## Problem Statement / Motivation

The grant tracking module (committed `00165d7`) replaced the old Google Sheets workflow. But the table is
read-only: to change a single field — bump a status to *Funded*, fix a due date, paste a proposal link — a
collaborator must open the grant, scroll a multi-section form, save, and navigate back. For a weekly triage
pass over ~30–50 grants that's a lot of round-trips. The whole point of the module was to let collaborators
self-serve edits instead of routing through Luke; inline editing removes the last friction.

The cronograma already proved an in-row editor works in this codebase
(`docs/plans/2026-05-18-feat-cronograma-in-row-editor-plan.md`); this applies the same idea to grants, but as
true live cells rather than a modal — consistent with the user's stated preference against popups (the notes
viewer was just reworked from a tooltip to in-place expansion).

## Proposed Solution

### Interaction model (decided)

- **Live editable cells**, **all displayed columns** editable.
- Default state: each cell renders its **formatted display** exactly as today (status badge, `formatUsd`,
  `formatDate` + urgency `Nd` badge, link pills, notes with the existing line-clamp/hover-expand).
- Editor clicks a cell → it switches to the matching input, pre-filled with the raw value, autofocused.
- **Enter** (single-line inputs) blurs → saves. **Shift+Enter** in the notes textarea inserts a newline.
  **Escape** reverts to the last-saved value without saving. **Blur** saves iff the value changed (dirty).
- On success: the cell shows the server-returned canonical value (re-formatted) + a brief ✓; then
  `router.refresh()` re-syncs cross-component derived data (summary cards, analytics, urgency badge). Because
  the save fires on blur, there is no focused input for `router.refresh()` to disturb.
- On error: red ring + the action's Spanish/English error in a `title`; the cell stays in edit mode so the
  value isn't lost.
- **Viewers** (`viewer` role) see today's read-only display — no inputs, no click affordance.

### The full-row link overlay must be removed

Today each row is one big link: `page.tsx:210` puts `after:absolute after:inset-0` on the grant-name
`<Link>`, making the entire row navigate to `/grants/{id}`. That overlay sits *above* every cell — it is
incompatible with clickable/editable cells (it would swallow every click). **Remove it.** Replace row-level
navigation with an explicit, scoped affordance:

- The grant **name** becomes an editable text cell (click to edit).
- A small **`↗` "open grant"** icon link is added at the end of the name cell (`relative z-10`,
  `onClick` stops propagation) → `/grants/{id}`. This preserves "open the full record" without hijacking
  cell clicks.
- The existing funder sub-link (`↗ {funderName}`) stays (already `relative z-10`).

### Architecture: RSC page + client cell islands

Keep `src/app/grants/page.tsx` a **Server Component** (SSR sortable headers, filters, summary all stay
server-rendered). Only the *contents* of each editable cell become small `"use client"` islands. This is the
minimal-blast-radius approach and mirrors how the admin page islands its per-cell `<Select>` controls
(`src/app/admin/admin-client.tsx:377-409`).

One generic component does most of the work:

```tsx
// src/app/grants/editable-field.tsx  ("use client")
type FieldKind = "text" | "amount" | "date" | "number" | "textarea" | "status" | "url";

interface EditableFieldProps {
  grantId: number;
  field: EditableGrantField;   // shared union (below)
  value: string | number | null;
  kind: FieldKind;
  canEdit: boolean;
  // optional per-kind extras: min/max (number), urgentDays (date), etc.
}
```

Behavior: holds `display | editing` local state + `useTransition`. In display mode it renders the **same
formatted output as today** (it imports the client-safe `formatUsd`/`formatDate`/`daysUntil` and
`GRANT_STATUS_LABELS`/`GRANT_STATUS_COLORS` from `@/lib/grants/constants`). In edit mode it renders the
input for `kind`. On commit it calls `updateGrantField(grantId, field, raw)` and applies the returned
canonical value. **Pass primitives, not React nodes** — the cell formats itself, so we avoid the
documented "can't pass a Lucide component / element as a prop to a client island and re-derive it" trap
(see Gotchas: Server→Client serialization). `canEdit === false` → render display only.

Two cells are special (not a single scalar):

- **`EditableLinks`** (`editable-links.tsx`): shows the 4 link pills (Website/Folder/Budget/Proposal). When
  `canEdit`, a small pencil toggles an **inline disclosure** *within the cell* (NOT a popup) holding four
  `EditableField kind="url"` instances — each autosaves independently via the same action. No new grouping
  action needed.
- **`EditableFunder`** (`editable-funder.tsx`): reuses the existing `FunderPicker`
  (`src/app/grants/funder-picker.tsx`) in an onChange/inline mode. Selecting a funder calls
  `updateGrantField(id, "funderId", id)`; typing a one-off name calls
  `updateGrantField(id, "funderNameRaw", name)`. Setting `funderId` clears `funderNameRaw` server-side
  (mirrors existing `linkGrantFunder`). This is the most complex cell — see Phase 3.

### Single server action (`updateGrantField`)

Add to `src/app/grants/actions.ts` one whitelisted, per-field-validated mutation rather than a dozen
one-off actions:

```ts
const EDITABLE_FIELDS = [
  "name", "status", "amountRequested", "amountAwarded", "dueDate",
  "notifyBeforeDays", "checkRfpDate", "notes",
  "website", "folderLink", "budgetLink", "proposalLink",
  "funderId", "funderNameRaw",
] as const;
export type EditableGrantField = (typeof EDITABLE_FIELDS)[number];

export interface UpdatedField {
  field: EditableGrantField;
  // canonical stored value, serialized for the client to re-render:
  value: string | number | null;
  // dueDate/checkRfpDate come back as ISO "YYYY-MM-DD" (or null) for formatDate.
}

export async function updateGrantField(
  id: number,
  field: EditableGrantField,
  raw: string | null,
): Promise<ActionResult<UpdatedField>> {
  const user = await requirePermission(PROJECT, "editor");
  if (!EDITABLE_FIELDS.includes(field)) return { success: false, error: "Unknown field." };

  // Per-field coercion + validation (reuse the existing helpers in this file).
  // switch(field): name → required text; status → enum guard; amount* → parseAmount;
  // dueDate/checkRfpDate → parseDate (UTC-midnight); notifyBeforeDays → clamp 0..365;
  // funderId → int|null (and clear funderNameRaw); funderNameRaw → text (only when no funderId);
  // links/notes → text(). Reject invalid with a clear message; never write garbage.

  try {
    await db.update(grants).set({ [col]: coerced, updatedAt: new Date() }).where(eq(grants.id, id));
    await recordEvent({
      source: "grants", projectId: PROJECT,
      eventType: field === "status" ? "grant_status_changed" : "grant_updated",
      actorEmail: user.email, targetType: "grant", targetId: id,
      summary: `Grant #${id} ${field} updated`,
      details: { field },
    });
    revalidatePath("/grants");
    revalidatePath(`/grants/${id}`);
    return { success: true, data: { field, value: canonical } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Failed to save." };
  }
}
```

Notes:
- **Reuse, don't duplicate**, the existing `parseAmount` / `parseDate` / `text` helpers in `actions.ts`
  (lines 212–231). The new function shares them.
- `updateGrantStatus` (actions.ts:317) becomes redundant for the table; keep it for now (it's also used by
  the detail page) or have the status cell call `updateGrantField(id,"status",…)`. Recommendation: route the
  table status cell through `updateGrantField` and leave `updateGrantStatus` untouched (no behavior change
  elsewhere). Don't delete it in this PR.
- **Date canonicalization**: store at UTC midnight (existing `parseDate`), return ISO `YYYY-MM-DD` so the
  client's `formatDate` (UTC-formatted) shows the same day with no drift (see Gotchas).

### Permissions

- `updateGrantField` calls `requirePermission("grants", "editor")` as its first line — action-layer
  enforcement, never UI-only hiding (CLAUDE.md).
- `page.tsx` already calls `requirePermission("grants", "viewer")`, which **returns the user**. Read
  `user.projectRoles?.grants` to compute `canEdit = role === "editor" || role === "admin"` and thread it to
  every cell island (matches the `canEditNotes`/`canEditSchedule` pattern from the cronograma plan).

### Refresh / cache invalidation

- Optimistic in-cell update is shown immediately.
- The action calls `revalidatePath("/grants")` + `revalidatePath("/grants/${id}")`.
- After a successful save the cell calls `router.refresh()` so **cross-component derived data updates**:
  the `GrantsSummary` cards (status/amount feed them), the urgency `Nd` badge (due date), and analytics on
  next visit. This satisfies the CLAUDE.md rule: "ensure related components (tables, sidebars) reflect the
  mutation." Safe because the save fires post-blur (no focused input to lose).

## Technical Considerations

- **Server→Client serialization**: cells receive **primitive** `value` + string `kind` and format
  themselves on the client using the client-safe `@/lib/grants/constants` helpers. Do not pass pre-rendered
  badges/icons/elements as props expecting to re-derive them (documented runtime trap — `npm run build`
  won't catch it).
- **Focus & keypress**: Enter on single-line inputs calls `e.currentTarget.blur()` (blur handler does the
  save) to avoid a double-submit; Escape resets local value and exits edit mode without saving;
  `shift+Enter` is allowed in the notes textarea.
- **Concurrency**: per-field last-write-wins (same rationale the cronograma plan used for its one-shot date
  edit — a single-field write can't clobber unrelated fields). No optimistic-hash locking needed for v1.
- **Validation at the boundary**: every field is validated server-side regardless of the input's client
  constraints (the action is directly reachable). Bad amount/date/status → `ActionResult` error, no write.
- **Instrumentation policy**: inline field edits are low-frequency, human-driven, and the module already
  surfaces "last updated by/when" via `getGrantActivity` over `system_events`. Emit **one** `grant_updated`
  (or `grant_status_changed` for status) event per successful save — this is intentional and *not* the
  high-frequency autosave case CLAUDE.md says to batch (a triage pass is a handful of edits, not a per-row
  loop). Reuse existing event types; no new `JOB_LABELS`/`AUDIO_JOB_TYPES` entries (those are for
  `processing_jobs`, unrelated here).
- **Notes cell synthesis**: the notes display mode reuses the just-shipped `ExpandCell` styling
  (`truncated-cell.tsx`: `line-clamp-2` + hover-expand). Clicking it enters edit mode (auto-growing
  `<textarea>`); blur saves. View-by-hover and edit-by-click coexist.
- **Sorting/filtering untouched**: SSR sortable headers + the GET filter form stay server-rendered; only
  cell *contents* are islanded. `getGrants` is unchanged.
- **Tables-sortable convention**: already satisfied (existing `SortableHeader`); no regression.

## Implementation Phases

### Phase 0 — Action + shared types (no UI yet)

- `src/app/grants/actions.ts`: add `EDITABLE_FIELDS`, `EditableGrantField`, `UpdatedField`, and
  `updateGrantField` (above). Reuse `parseAmount`/`parseDate`/`text`. Keep `updateGrantStatus` as-is.
- Confirm `user.projectRoles?.grants` is available from `requirePermission` (it is — used elsewhere).

### Phase 1 — Generic `EditableField` client component

- `src/app/grants/editable-field.tsx` (new, `"use client"`): display/edit state machine, `useTransition`,
  blur/Enter/Escape handling, optimistic value, ✓/error affordance, `router.refresh()` on success.
  Self-formats via `@/lib/grants/constants`. Handles kinds: `text`, `amount`, `date`, `number`, `textarea`,
  `status`, `url`.
- Read-only branch when `canEdit === false`.

### Phase 2 — Wire scalar cells in `page.tsx`

- Remove the `after:absolute after:inset-0` overlay (line 210). Keep `<TableRow className="relative group">`.
- Add the `↗` open-grant icon link in the name cell (`relative z-10`, `stopPropagation`).
- Replace cell contents:
  - Name → `EditableField kind="text" field="name"` (required).
  - Status → `EditableField kind="status" field="status"` (renders badge in display, `<select>` in edit).
  - Requested → `EditableField kind="amount" field="amountRequested"`.
  - Due date → `EditableField kind="date" field="dueDate"` (keeps the urgency `Nd` badge in display mode).
  - Notify → `EditableField kind="number" field="notifyBeforeDays"` (min 0, max 365).
  - RFP check → `EditableField kind="date" field="checkRfpDate"`.
  - Notes → `EditableField kind="textarea" field="notes"` (display reuses `ExpandCell` styling).
- Compute `canEdit` in the page and pass to every cell.

### Phase 3 — Special cells: links + funder

- `src/app/grants/editable-links.tsx` (new): pill display + pencil → inline disclosure with four
  `EditableField kind="url"` (website/folderLink/budgetLink/proposalLink). Drop the standalone `LinkChips` in
  favor of this (it absorbs the display).
- `src/app/grants/editable-funder.tsx` (new): inline reuse of `FunderPicker`. Page must now call
  `getFunderOptions()` and pass options down. Selecting a funder → `updateGrantField(id,"funderId",…)`;
  one-off name → `updateGrantField(id,"funderNameRaw",…)`. Server clears `funderNameRaw` when `funderId` set.

### Phase 4 — Tests + manual QA

- **Unit** (`tests/unit/grants-actions-coerce.test.ts` or extend existing): per-field coercion in
  `updateGrantField` — amount strips `$`/commas; bad date rejected; `notifyBeforeDays` clamps to 0..365;
  invalid status rejected; setting `funderId` clears `funderNameRaw`; unknown field rejected.
- **Action-layer** (integration): `updateGrantField` rejects `viewer` (auth), accepts `editor`; emits exactly
  one event (`grant_status_changed` for status, else `grant_updated`); writes only the targeted column.
- **Manual QA** (`http://localhost:3003`, via `docker compose exec portal` for any DB scripts):
  - As editor: edit each field type → blur saves, badge/format updates, summary cards re-sync.
  - Enter saves; Escape reverts; bad amount shows error and keeps edit mode.
  - Status change updates the colored badge and the "Grants funded / awaiting" summary counts.
  - `↗` opens the detail page; clicking a cell does NOT navigate.
  - As viewer: cells are read-only, no inputs.
  - Notes: hover still expands (view); click edits; long note saves with newlines.
  - Confirm `system_events` shows `grant_updated`/`grant_status_changed` with `actorEmail`.

## Acceptance Criteria

### Functional
- [ ] Every displayed grants column is editable in place by an editor; viewers see read-only display.
- [ ] Click a cell → input appears prefilled; blur or Enter saves; Escape reverts; invalid input is rejected
      with a visible error and the cell stays editable.
- [ ] Status edit updates the colored badge and the `GrantsSummary` cards without a manual reload.
- [ ] Due-date edit updates the urgency `Nd` badge; dates show with no day-drift.
- [ ] Links cell edits four URLs inline (no popup); funder cell links/uses a one-off name via the picker.
- [ ] The full-row link overlay is gone; a scoped `↗` icon opens the detail page; cell clicks never navigate.

### Auth / persistence / telemetry
- [ ] `updateGrantField` calls `requirePermission("grants","editor")` first; a `viewer` calling it directly
      is rejected.
- [ ] Only the targeted column (+ `updatedAt`, + `funderNameRaw` clear on `funderId`) is written.
- [ ] Exactly one `grant_updated`/`grant_status_changed` event per successful save, with `actorEmail`.

### Quality
- [ ] `npm run build`, `npm run lint`, and `npm run test:run` pass (watch for Server→Client serialization).
- [ ] No layout regression: column widths, alignment, and the summary cards are unchanged in display mode.

## Dependencies & Risks

- **No new dependencies.** Reuses `Select`/`Input`/`Textarea`/`Button` (shadcn), `useTransition`,
  `useRouter`, `FunderPicker`, `recordEvent`, `requirePermission`, and the grant coercion helpers.
- **Risk — removing the row overlay** could feel like lost navigation. Mitigated by the explicit `↗` icon;
  the name link still goes nowhere on click (it edits) so the icon is the single, discoverable way in.
- **Risk — `router.refresh()` churn** on every field edit. Acceptable: it fires only on success, post-blur,
  on a small table; if it feels heavy, scope refresh to status/amount/date (the only cross-component fields)
  and skip it for links/notes/name. Note as a tuning lever, not a blocker.
- **Risk — funder inline cell** is the highest-complexity piece (combobox + dual funderId/funderNameRaw).
  If it slips, ship Phases 0–2 + links first; funder cell falls back to today's read-only sub-link until
  Phase 3 lands. (Do not silently cut it — it's part of the chosen "all columns" scope; flag if descoping.)
- **Risk — concurrent editors**: last-write-wins per field. Same accepted trade-off as the cronograma
  one-shot date edit. Revisit with optimistic hashing only if collisions are reported.

## Open Questions (deferred)
- Apply the same editable cells to the **funders** table (`/grants/funders`) — same components, easy v2.
- Keyboard navigation between cells (Tab/arrow to next editable cell) — nice-to-have, not v1.
- Bulk edit (select rows → set status) — separate feature.

## References & Research

### Internal references
- Grants table to convert: `src/app/grants/page.tsx` (full-row overlay at `:210`; cells `:206-264`).
- Existing actions to extend/reuse: `src/app/grants/actions.ts` — `updateGrantStatus` (`:317`),
  `linkGrantFunder` (`:350`), coercion helpers `parseAmount`/`parseDate`/`text` (`:212-231`),
  `getFunderOptions` (`:197`), `getGrantActivity` (`:135`).
- **Live-cell precedent (closest pattern)**: admin per-cell `<Select onValueChange>` → `useTransition` →
  server action → `router.refresh()` — `src/app/admin/admin-client.tsx:377-409`,
  `src/app/admin/actions.ts:136-196`.
- Click-guard for interactive cells in clickable rows: `e.currentTarget.contains(e.target)` +
  per-cell `e.stopPropagation()` — `src/app/camera-trap/results/results-table.tsx:216-289`,
  `src/app/audio/audio-deployments-shell.tsx:672-692`.
- In-row editor design precedent: `docs/plans/2026-05-18-feat-cronograma-in-row-editor-plan.md`
  (permissions threading, optimistic close + `router.refresh()`, ActionResult error localization).
- Reusable pieces: `src/app/grants/funder-picker.tsx`, `src/app/grants/truncated-cell.tsx` (`ExpandCell`),
  `src/lib/grants/constants.ts` (client-safe formatters/labels), `src/components/ui/*`.

### CLAUDE.md conventions in play
- `requirePermission()` on every action; `ActionResult<T>`; `recordEvent()` for admin-facing mutations;
  tables sortable by default (already satisfied); UI cache invalidation across related components after a
  mutation; grants module is intentionally **English** (do not translate); per-field date storage at UTC
  midnight to avoid day-drift; Server→Client serialization caveat (pass primitives, not elements).
