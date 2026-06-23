---
title: Grant reminders, RFP cleanup, and funder inline editing
date: 2026-06-23
status: brainstormed
module: grants
---

# Grant reminders + table decluttering + funder inline editing

## What We're Building

Three related changes to the grant-tracking module, unified by one theme: **make reminders
automatic and declutter the tables of manual, rarely-used columns**, then bring the funders
table to parity with the now-inline-editable grants table.

1. **Two-tier automatic due-date reminders.** Every active grant automatically emails grants
   editors/admins **30 days** and **14 days** before its due date — no per-grant configuration.
   Remove the manual **"Notify (days)"** column from the grants table.
2. **Drop the RFP-check field entirely.** `checkRfpDate` is inert (nothing acts on it; it's just a
   stored, sortable date). Remove it from the schema, the grants table, the create/edit forms,
   the detail view, the sort map, and `updateGrantField`.
3. **Inline editing for the funders table.** Mirror the grants table: every funder column editable
   in place via a new `updateFunderField` server action + editable client cells.

## Why This Approach

**Reminders today fire only once.** The daily cron (`/api/cron/grants-reminders`, 8:30 AM ET)
selects active grants where `daysUntil(dueDate)` is within `[0, notifyBeforeDays]` and
`lastNotifiedAt IS NULL`, sends one email to all grants editors/admins, then stamps
`lastNotifiedAt` so it never fires again (`src/lib/grants/emails.ts:265`,
`src/app/api/cron/grants-reminders/route.ts`). A single `notifyBeforeDays` + single
`lastNotifiedAt` structurally **cannot** produce two reminders — so "1 month *then* 2 weeks"
requires a fixed two-threshold schedule with **per-threshold** sent-tracking.

Making it global+automatic (vs. per-grant config) matches how the field is actually used and lets
us delete the "Notify (days)" column — one less thing collaborators must set correctly. RFP check
is removed for the same decluttering reason; it has no consumers, so dropping it is safe.

Funders inline editing reuses the exact pattern just shipped for grants (`updateGrantField` +
`editable-cell.tsx`), so it's low-risk and consistent.

## Key Decisions

- **Reminder schedule = global constant `[30, 14]` days.** Define once (e.g.
  `GRANT_REMINDER_DAYS` in `src/lib/grants/constants.ts`) so a third threshold is a one-line change.
  No per-grant override (chosen over "global default + override").
- **Recipients & email content unchanged** — all `grants` editors+admins; existing HTML template,
  now labeled by which threshold fired (e.g. "due in 14 days").
- **Per-threshold dedupe.** The single `lastNotifiedAt` boolean-style stamp is insufficient. Need
  to track *which* thresholds have fired per grant (e.g. a `notified_30_at` / `notified_14_at`
  pair, a small `grant_reminders_sent` table, or a bitmask). Decide the exact shape in planning;
  the send-then-mark + retry-on-failure semantics should be preserved.
- **"Notify (days)" column removed from the grants table.** The `notifyBeforeDays` schema column
  becomes unused — decide in planning whether to drop it (table-recreation migration) or leave it
  vestigial.
- **`checkRfpDate` dropped entirely** — every reference removed. Physically dropping the SQLite
  column needs a table-recreation migration (per the project's Drizzle/SQLite gotcha); confirm in
  planning whether to drop the column or just remove all UI/code references and leave it unused.
- **All funder columns editable.** priority (`funderPriorityEnum`), funderType & relationshipStatus
  (free text — no enum today, keep free text per YAGNI), focusAreas/nextSteps/description/notes
  (textarea), nextStepDue (date), contactName/contactEmail, website + the three research links
  (irs990/guidestar/foundationDirectory). New `updateFunderField` mirrors `updateGrantField`
  (requirePermission "editor" → field whitelist → coercion switch → `recordEvent` `funder_updated`
  → `revalidatePath`). Remove the full-row link overlay; add a scoped "open funder" icon like the
  grants table.

## Edge Cases to Handle (planning)

- A grant entered/edited when it's already <30 (or <14) days out should still receive the
  not-yet-sent thresholds it's within, and skip ones already passed. The per-threshold "fire once
  when entering `[0, threshold]` and not yet sent" rule handles this naturally.
- Changing a grant's due date later: thresholds re-evaluate against the new date; already-sent
  thresholds stay sent (don't re-spam). Confirm desired behavior in planning.
- Status moving to a decided state mid-window suppresses further reminders (already handled by the
  `GRANT_DECIDED_STATUSES` filter).

## Open Questions

- Add a **day-of / overdue** reminder too, or strictly 30+14? (Default: strictly 30+14.)
- On a due-date change, should a passed-and-sent threshold be eligible to re-fire if the new date
  pushes it back into the future? (Default: no re-send.)
- Drop the now-unused `notifyBeforeDays` column and the `checkRfpDate` column physically, or leave
  them in the DB unused to avoid a migration? (Leaning: remove from all UI/code now; physical
  column drop optional.)

## References

- Reminder cron: `src/app/api/cron/grants-reminders/route.ts`; logic `src/lib/grants/emails.ts:265`
  (`getDueReminders`, `getGrantsRecipients`, `markReminded`).
- Schedule: `scripts/crontab` (8:30 AM ET daily). Dedupe column: `grants.lastNotifiedAt`
  (`src/db/schema.ts:1540`). RFP: `grants.checkRfpDate` (`src/db/schema.ts:1539`).
- Grants inline-edit pattern to mirror: `src/app/grants/actions.ts` (`updateGrantField`),
  `src/app/grants/editable-cell.tsx`, `src/lib/grants/constants.ts` (`EDITABLE_GRANT_FIELDS`).
- Funders: `src/app/grants/funders/page.tsx`, `funders/actions.ts` (`getFunders`, `saveFunder`),
  `funders` schema `src/db/schema.ts:1488`.

Next: Run `/workflows:plan` when ready to implement.
