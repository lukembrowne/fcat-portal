---
date: 2026-05-18
topic: cronograma-in-row-editor
---

# Cronograma In-Row Schedule Editor (Biochoco)

## What We're Building

A per-row "Editar" action on the Biochoco cronograma (`src/app/biochoco/overview/schedule-table.tsx`) that opens a modal dialog and lets editors do two things on a scheduled deployment without leaving the table:

1. **Swap dates** with another scheduled deployment, with same-habitat candidates surfaced first to preserve stratified sampling.
2. **Shift fecha-plan directly** via a date picker; the planned retrieve date auto-shifts by the same interval so the deployment duration is preserved.

Both flows continue to write through to the Google Sheets schedule (the existing source of truth) using the current preview-hash-commit pattern, and emit a `recordEvent()` audit entry. This replaces the two-dropdown workflow that lives today at `/biochoco/tools` → Intercambiar Fechas for the common case.

## Why This Approach

The current `Tools → Intercambiar Fechas` page (`src/app/biochoco/tools/date-swap.tsx`) requires the user to mentally hold two deployment IDs and pick them from a long unsorted dropdown with no habitat filter — workable for Luke, painful for Karla rearranging 8 rows for a month. Anchoring the action to the row the user is already looking at removes that mental step. Keeping habitat filtering as the default candidate list (with an opt-out to "Mostrar otros hábitats") protects the stratified design without making the system rigid.

We considered an inline expanding row and a side sheet; the modal dialog won because the candidate list can grow long (~15-20 same-habitat options), needs vertical room for preview, and shouldn't fight the table's horizontal layout.

We're keeping the existing standalone Tools page for now — it stays useful for bulk shift and validation, and as a fallback if the in-row flow has issues. We are NOT removing `date-swap.tsx` in this iteration; if usage migrates over, we can revisit.

## Key Decisions

- **Operations supported**: Swap dates with another row + edit fecha-plan directly. No "delete row" or "edit retrieve date independently" in v1 (YAGNI — can be added if asked).
- **Swap target filter**: Same habitat first by default, with a "Mostrar otros hábitats" toggle that expands to the full scheduled list. Habitat matches `habitatType` from the row, not the display label.
- **UI surface**: Action button on each row → modal dialog (Dialog from `@/components/ui/dialog`). Both swap controls and direct date edit live in the same dialog as two clearly separated sections.
- **Date edit semantics**: Editing fecha-plan auto-shifts the planned retrieve date by the same number of days. Single date input keeps it predictable and prevents invalid deploy↔retrieve intervals. Season is recalculated server-side (existing `assignSeason()` helper).
- **Permissions**: Loosen from admin-only (current Tools page) to `editor` and above on the `biochoco` project, so station managers like Karla can self-serve. Audit event still names the actor.
- **Persistence**: Reuse `loadSchedule()` / `saveSchedule()` + the `scheduleHash()` optimistic-lock pattern. Writes still go to the Google Sheet as the source of truth. New server actions live alongside the existing swap actions in `src/app/biochoco/tools/actions.ts` (or a sibling module).
- **Event logging (required)**: Every successful mutation MUST call `recordEvent()` from `@/lib/system-events`, matching the pattern in the existing `commitDateSwap` / `commitBulkShift` / `commitAddSite` actions. New event types: `schedule_inline_swap` (in-row swap) and `schedule_date_edit` (direct fecha-plan change). Summary line names the actor, the deployment ID(s), and the before→after dates so the activity feed is human-readable. This is non-negotiable per CLAUDE.md guidance — admin-facing mutations of schedule data are exactly the category that must emit events.
- **Eligible rows**: Only `status === "scheduled"` rows show the Editar button. Deployed/retrieved rows are immutable in this dialog (their actual dates are field data).
- **Row identity**: Each deployment appears twice in the table (deploy row + retrieve row). Clicking Editar on either opens the dialog scoped to the same underlying deployment; the dialog always shows both planned dates.

## Open Questions

- **Slot template**: When a user direct-edits a date, what happens to `deploySlotId` / `retrieveSlotId`? Swap already moves slot IDs along; a free-form date edit could leave a row pointing to a slot whose date no longer matches. Options: (a) clear the slot ID on direct edit, (b) snap the date to the nearest slot, (c) leave it and let validation flag it. Need to confirm whether the slot template is still load-bearing in 2026 use.
- **Validation surfacing**: Should `validateSchedule()` errors block the commit, or just warn? Today the Tools page lets users see validation as a separate panel. In-row, a warning banner above the "Aplicar" button feels right.
- **Deprecate Tools → Intercambiar Fechas?**: After this ships and is in use for ~1 month, consider removing the standalone date-swap UI to reduce surface area. Keep bulk-shift / add-site / sync-odk where they are.
- **Date picker constraints**: Should the picker block weekends or holidays? `isValidWorkDay()` already exists in `schedule-utils.ts`. Decide v1.
- **Notification to field team**: When dates change for a deployment a technician was expecting, is there a Slack/email broadcast we should trigger, or does the field crew just re-check the cronograma view in the morning?

## Next Steps

→ Run `/workflows:plan` to translate this into an implementation plan (file changes, new server actions, dialog component, permission updates, tests).
