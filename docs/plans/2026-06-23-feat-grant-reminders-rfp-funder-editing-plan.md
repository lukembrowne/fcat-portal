---
title: Grant reminders auto-schedule, RFP cleanup, and funder inline editing
type: feat
date: 2026-06-23
brainstorm: docs/brainstorms/2026-06-23-grant-reminders-rfp-funder-editing-brainstorm.md
---

# ✨ Grant reminders (30 + 14 day), RFP cleanup, funder inline editing

## Overview

Three related changes to the grant-tracking module (intentionally **English**), unified by one
theme: make reminders automatic, declutter the grants table of two manual rarely-used columns, and
bring the funders table to parity with the now-inline-editable grants table.

1. **Two-tier automatic reminders.** Every active grant emails grants editors/admins **30 days** and
   **14 days** before its due date — no per-grant config. Drop the manual **"Notify (days)"** column.
2. **Drop the RFP-check field entirely.** `checkRfpDate` is inert (nothing reads it). Remove it from
   schema, table, forms, detail view, sort map, and `updateGrantField`.
3. **Inline editing for the funders table.** Mirror the grants table: a new `updateFunderField`
   action + reused editable client cells make every displayed funder column editable in place.

## Problem / Motivation

- The reminder cron (`src/app/api/cron/grants-reminders/route.ts`, daily 8:30 AM ET) can only ever
  fire **once per grant**: `getDueReminders` filters `isNull(grants.lastNotifiedAt)` and a single
  `notifyBeforeDays` window, then `markReminded` stamps `lastNotifiedAt` (`src/lib/grants/emails.ts:265,298`).
  A single threshold + single stamp **structurally cannot** produce "1 month then 2 weeks."
- `checkRfpDate` is a stored/sortable date with **zero consumers** — pure table clutter.
- The funders table (`src/app/grants/funders/page.tsx`) still requires clicking through to a detail
  page to edit, unlike grants which now edits in place.

## Key Decisions (from brainstorm)

- Reminder schedule is a **global constant `GRANT_REMINDER_DAYS = [30, 14]`** — no per-grant override.
- **Drop `checkRfpDate` and `notifyBeforeDays`** columns physically (the user wants them gone).
- **All displayed funder columns** become inline-editable; non-displayed fields (website, the three
  research links, funding history) stay on the detail/edit form.
- Recipients & email layout unchanged (all grants editors+admins; existing HTML lists each grant with
  its days-remaining — no need to label "30-day vs 14-day").

---

## Technical Approach

### Reminder model: per-grant "reminders sent" counter

Replace the single `notifyBeforeDays`/`lastNotifiedAt`-as-boolean dedupe with a small **count of
thresholds already notified**, so each threshold fires exactly once and a grant entered late only
gets the still-applicable (most urgent) reminders.

Pure helper (add to `src/lib/grants/constants.ts`, client-safe):

```ts
export const GRANT_REMINDER_DAYS = [30, 14] as const; // descending

/** How many reminder thresholds the grant has entered (0 if not due / overdue). */
export function reminderLevel(days: number | null): number {
  if (days == null || days < 0) return 0;
  return GRANT_REMINDER_DAYS.filter((t) => days <= t).length;
}
```

`days=40 → 0`, `30 → 1`, `25 → 1`, `14 → 2`, `8 → 2`, `0 → 2`, overdue → 0.

`getDueReminders(now)` (`src/lib/grants/emails.ts`): select active, `dueDate IS NOT NULL`, status not
decided, plus the new `remindersSent` column (drop the `isNull(lastNotifiedAt)` filter and the
`notifyBeforeDays` selection). For each candidate compute `level = reminderLevel(days)`; **include it
iff `level > remindersSent`**, carrying `targetLevel = level`. One batch email lists all included
grants (unchanged `renderRemindersHtml`).

`markReminded(updates: { id: number; level: number }[], now)`: per grant set
`remindersSent = level` and `lastNotifiedAt = now` (sequential `await db.update(...)`; small N).

Edge behavior (all desired): grant entered at 8 days → one email (the 14-day), `remindersSent→2`, no
late 30-day blast. Due date pushed further out after both sent → `level ≤ remindersSent` → no
re-send. Overdue → `level 0` → not reminded (strictly 30+14, per brainstorm).

Cron route changes are minimal: use `targetLevel` when calling `markReminded`; subject/recipients/
`recordEvent` unchanged.

### Schema migration (grants table)

better-sqlite3 ships SQLite ≥3.35, and `scripts/push-schema.mjs` runs each migration in a
swallow-catch loop (`for (const m of migrations) { try { db.exec(m); } catch {} }`, line 864), so
**`DROP COLUMN` works directly and re-runs are safe** — no table recreation. Neither dropped column
is indexed.

- `src/db/schema.ts` `grants` (≈1538-1540): delete `notifyBeforeDays` and `checkRfpDate`; add
  `remindersSent: integer("reminders_sent").notNull().default(0)`. Keep `lastNotifiedAt`.
- `scripts/push-schema.mjs`:
  - CREATE TABLE `grants` (714-733): drop the `notify_before_days` + `check_rfp_date` lines; add
    `reminders_sent INTEGER NOT NULL DEFAULT 0`.
  - `migrations` array (≈743): add
    `ALTER TABLE grants ADD COLUMN reminders_sent INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE grants DROP COLUMN check_rfp_date`,
    `ALTER TABLE grants DROP COLUMN notify_before_days`.
- Apply on the server **after a backup**, via Docker (host scripts corrupt SQLite under the running
  container): `docker compose exec -T portal node scripts/backup-db.mjs` then
  `docker compose exec portal node scripts/push-schema.mjs`.

### Funder inline editing (mirror grants)

Generalize the existing grants editable cells so funders reuse them rather than duplicating:

- `src/app/grants/editable-cell.tsx`: add an optional `action` prop to `EditableField` (default
  `updateGrantField`) and widen its `field` type to `string`; the internal save hook calls the passed
  action. Add a generic **`EditableSelect`** (nullable enum: badge/text → click → `<select>` with a
  "— none —" option) for funder `priority`. No behavior change for existing grants usage.
- `src/lib/grants/constants.ts`: add `EDITABLE_FUNDER_FIELDS` + `EditableFunderField` (whitelist:
  name, priority, funderType, focusAreas, relationshipManager, relationshipStatus, nextSteps,
  nextStepDue, contactName, contactEmail, description, notes, website, fundingHistory, irs990Link,
  guidestarLink, foundationDirectoryLink).
- `src/app/grants/funders/actions.ts`: add `updateFunderField(id, field, raw)` mirroring
  `updateGrantField` (`src/app/grants/actions.ts:366`): `requirePermission(PROJECT, "editor")` →
  whitelist check → coercion switch (reuse existing `text`/`parseDate` helpers, lines 169/175) →
  `db.update(funders)` → `recordEvent` `funder_updated` (already a used event type, line 236) →
  `revalidatePath("/grants/funders")` + `/grants/funders/${id}` → return `ActionResult<UpdatedFunderField>`
  (dates as `YYYY-MM-DD`). **`name` is special**: required, and must recompute
  `nameNormalized = normalizeFunderName(name)` (the column has a UNIQUE index, line 1516) and return
  the friendly "equivalent name already exists" message on a UNIQUE collision (reuse the catch in
  `saveFunder`, lines 248-253).
- `src/app/grants/funders/page.tsx`: capture `user` from `requirePermission` and compute `canEdit`
  (same role check as `src/app/grants/page.tsx:86-88`). Replace the full-row link overlay
  (`after:absolute after:inset-0` on the name `Link`, line 151) with an `EditableField` for the name +
  a scoped `↗` ExternalLink "open funder" icon (mirror grants `page.tsx:207-213`). Wire each displayed
  column to `EditableField`/`EditableSelect` with `action={updateFunderField}`; contact becomes two
  stacked editable fields (name, email). `grantCount` stays read-only.

### Grants UI cleanup (remove Notify + RFP)

Remove every reference found by grep:
- `src/app/grants/page.tsx`: delete the `notify` and `rfp` `SortableHeader`s (152-153) and the two
  `EditableField` cells (≈220-243). Resulting columns: Grant, Status, Requested, Due date, Links, Notes.
- `src/app/grants/actions.ts`: drop from `GrantListItem` (34-35), `SORTABLE_COLUMNS` (50-51),
  `getGrants` select (78-79), `createGrant`/`saveGrant` FormData parse (252-254, 273-274), and the
  `notifyBeforeDays` + `checkRfpDate` cases in `updateGrantField` (407-414, 421-426).
- `src/lib/grants/constants.ts`: remove `"notifyBeforeDays"` and `"checkRfpDate"` from
  `EDITABLE_GRANT_FIELDS` (69-70).
- `src/app/grants/grant-form.tsx`: drop the two `Field` blocks (169-180) and the `initial` interface
  members (23-24). `src/app/grants/new/page.tsx`: drop initial values (29-30).
  `src/app/grants/[id]/page.tsx`: drop the two `initial` props (62-63).
- `src/lib/grants/emails.ts`: `getDueReminders` no longer selects/uses `notifyBeforeDays` (replaced by
  the reminder-level logic above).

---

## Acceptance Criteria

- [x] Active grants generate a reminder email when they cross **30 days** out and again at **14 days**;
      each threshold fires at most once; overdue grants are not emailed.
- [x] A grant first seen inside 14 days gets exactly one (the 14-day) email, not a duplicate 30-day.
- [x] Moving a due date further out after reminders sent does **not** re-send.
- [x] The grants table no longer shows "Notify (days)" or "RFP check"; both columns are gone from the
      schema, create/edit form, new page, detail view, sort map, and `updateGrantField`.
- [x] The funders table edits every displayed column in place (priority via a dropdown, dates via a
      date input, text/long-text inline); editing a funder name recomputes `nameNormalized` and
      surfaces the duplicate-name error; a scoped `↗` icon opens the funder detail page.
- [x] Viewers see read-only cells on both tables; only editors/admins (or super_admin) can edit.
- [x] `recordEvent` fires `funder_updated` on funder field edits.
- [x] `npm run lint`, `npx tsc --noEmit` (no new grants errors), `npm run test:run`, `npm run build`
      all pass.

## Implementation Phases

### Phase 1 — Reminder model + schema
- `constants.ts`: `GRANT_REMINDER_DAYS`, `reminderLevel`. `schema.ts` + `push-schema.mjs` column
  changes. `emails.ts`: rewrite `getDueReminders`/`markReminded`. `route.ts`: pass `targetLevel`.

### Phase 2 — Grants table/forms cleanup
- Remove all `checkRfpDate`/`notifyBeforeDays` references (grep list above).

### Phase 3 — Funder inline editing
- Generalize `editable-cell.tsx`; add `EDITABLE_FUNDER_FIELDS` + `updateFunderField`; rewire
  `funders/page.tsx`.

### Phase 4 — Tests
- `tests/unit/grants-constants.test.ts`: replace the old `[0, notifyBeforeDays]` predicate (lines
  50-60) with `reminderLevel` cases (40→0, 30→1, 25→1, 14→2, 8→2, -2→0); assert `EDITABLE_GRANT_FIELDS`
  no longer contains the two removed fields; assert `EDITABLE_FUNDER_FIELDS` membership.
- New `tests/unit/grants-reminders.test.ts`: a pure simulation of the "include iff level >
  remindersSent" rule across the edge cases (late entry, push-out no-resend, both-sent).
- Funder coercion: add focused assertions (name required, `nameNormalized` recomputed, invalid
  priority rejected, unknown field rejected) following the existing `grants-coerce.test.ts` style.

## Dependencies & Risks

- **Migration is the riskiest step** (drops two prod columns). Mitigation: hourly backups exist; take a
  manual backup first; `DROP COLUMN` re-runs are swallowed if already applied. Run **only via
  `docker compose exec`**, never bare host (SQLite corruption gotcha).
- Server→Client serialization: editable cells receive only primitives (id, field string, value,
  canEdit, options) — verified safe, but `npm run build` won't catch a regression, so spot-check the
  rendered funders page.
- `"use server"` files export only async functions — `EDITABLE_FUNDER_FIELDS`/types must live in
  `constants.ts`, not the actions file (same trap already hit for grants).

## References

- Reminder cron + email: `src/app/api/cron/grants-reminders/route.ts`,
  `src/lib/grants/emails.ts:265-321`. Schedule: `scripts/crontab` (8:30 AM ET).
- Inline-edit pattern to mirror: `src/app/grants/actions.ts:366-494` (`updateGrantField`),
  `src/app/grants/editable-cell.tsx`, `src/lib/grants/constants.ts:63-79` (`EDITABLE_GRANT_FIELDS`).
- Funders: `src/app/grants/funders/page.tsx`, `funders/actions.ts` (`getFunders`, `saveFunder`,
  `text`/`parseDate`), schema `src/db/schema.ts:1485-1519`. Grants schema `:1521-1551`.
- push-schema migration loop: `scripts/push-schema.mjs:714-733, 743-866`.

## Verification

1. `npm run lint`; `npx tsc --noEmit` (grants clean); `npm run test:run`; `npm run build`.
2. Migration on a scratch copy first: `docker compose exec portal node scripts/push-schema.mjs`, then
   `PRAGMA table_info(grants)` to confirm `check_rfp_date`/`notify_before_days` gone and
   `reminders_sent` present, with rows intact.
3. Cron dry-run: seed a grant due ~25 days out, POST `/api/cron/grants-reminders` with the
   `CRON_SECRET` bearer → reminder sent, `remindersSent=1`; advance/seed one due ~12 days out → second
   reminder; re-POST same day → no duplicate.
4. Manual on dev (`http://localhost:3003`, grants editor): grants table shows no Notify/RFP columns;
   funders table edits priority/dates/text inline, name-rename recomputes normalization and rejects a
   duplicate, `↗` opens the detail page; viewer sees read-only.
