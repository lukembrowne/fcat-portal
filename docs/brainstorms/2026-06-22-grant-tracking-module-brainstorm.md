# Brainstorm: Grant Tracking Module

**Date:** 2026-06-22
**Status:** Ready for planning
**Lives under:** Administración (`/admin/grants`)

## What We're Building

A grant-tracking module inside the FCAT Portal that **fully replaces** the current
patchwork of (a) the `FCAT Grant and Funder Database` Google Sheet, (b) the Google
Form used to add grants, and (c) the n8n monthly-summary email. It lets collaborators
edit the grant pipeline directly instead of routing every change through Luke.

It covers three things:

1. **Grant pipeline** — track every grant through its lifecycle
   (`To Research → In Prep → Pending Decision → Funded / Rejected / Passed → Completed`),
   with amounts requested/awarded, due dates, links (folder, budget, proposal, website),
   and notes.
2. **Funder CRM** — the ~203 funders with priority, type, focus areas, relationship
   manager, relationship status, next steps + due date, contacts, funding history,
   description, and reference links (IRS 990 / GuideStar / Foundation Directory).
3. **New analytics + active workflows** — things the spreadsheet can't do: win-rate and
   $-by-year, success-rate by funder, pipeline forecasting, plus a prospecting worklist.

### Source-system inventory (what exists today)

- **Grants sheet (~118 rows):** ID, Grant Name, Funder, Website, Due Date, Status,
  Amount Requested, (Amount Awarded), Notes, Folder Link, Budget Link, Proposal Link,
  Last Notified, Notify Before (Days), Check RFP Date, + computed Days Until Due.
- **Funders sheet (~203 rows):** Funder Name, Website, Priority, Funder Type, Focus
  Areas, Relationship Manager, Relationship Status, Next Steps, Next Step Due, Contact
  Name, Contact Email, Funding History, Description, Notes, Last Modified, IRS 990,
  GuideStar, Foundation Directory.
- **n8n monthly email (1st @ 9am):** summary boxes (pending #/$, funded #/$), then
  sections — *In Prep*, *Due in Next 30 Days* (urgent badge ≤7d), *Awaiting Decision*
  (with total), and *yearly stats by status with $*.

## Why This Approach

The portal already has every primitive this module needs, so we mirror proven patterns
rather than invent anything:

- **Permissions:** add a `grants` entry to the `projects` table and gate everything with
  `requirePermission("grants", role)` (Visor/Editor/Admin). This is the "grants team
  allowlist" the user chose — controls who sees funder/financial detail, managed on the
  existing `/admin` page. Super-admins bypass automatically.
- **Module shape:** mirror `research-applications` (Drizzle table, `actions.ts` with
  `ActionResult<T>`, Server Component pages, SSR URL-param sortable tables via shared
  `SortIcon`).
- **Email + cron:** reuse Resend + the `verifyCronSecret` cron pattern (like
  `committee-monthly-digest`) to reproduce the monthly digest **and** send per-deadline
  reminders — retiring n8n entirely.
- **Audit:** `recordEvent({ source: "grants", ... })` on every mutation feeds the
  existing `/admin/activity` log.

This keeps grant data inside the portal's backup/restore, auth, and audit story instead
of a separate Google account + n8n instance.

## Key Decisions

| Decision | Choice |
|---|---|
| **Scope** | Grants + Funders CRM + **new analytics** (full option 3) |
| **Access model** | Grants-team allowlist — treat `grants` as a pseudo-project with Visor/Editor/Admin roles |
| **Notifications** | In-portal dashboard **+ monthly email digest + per-deadline reminders** (uses `Notify Before (Days)`) |
| **Data migration** | One-time import of **all ~118 grants + ~203 funders** from the xlsx |
| **Grant↔Funder link** | **Relational FK** — grants link to a funder record (inline add for one-offs); enables per-funder analytics |
| **Analytics** | Win rate & $ by year · Success rate by funder · Pipeline forecast (Time-to-decision deferred) |
| **Intake** | **In-portal "Add Grant" only** — retire the Google Form, one source of truth |
| **Prospecting** | **Yes** — surface a "funders to approach / RFPs to check" worklist from `To Research`, funder `Next Step Due`, and grant `Check RFP Date` |

## Proposed Data Model (sketch — to be finalized in planning)

- **`grants`** — id, funderId (FK → funders, nullable for legacy/one-off), name, website,
  status (enum), amountRequested, amountAwarded, dueDate, notifyBeforeDays, checkRfpDate,
  lastNotifiedAt, notes, folderLink, budgetLink, proposalLink, timestamps.
- **`funders`** — id, name, website, priority, funderType, focusAreas, relationshipManager,
  relationshipStatus, nextSteps, nextStepDue, contactName, contactEmail, fundingHistory,
  description, notes, irs990Link, guidestarLink, foundationDirectoryLink, timestamps.
- Status enum must be enforced in **both** the Drizzle `text({ enum })` *and* the
  `push-schema.mjs` CREATE TABLE CHECK constraint (known gotcha).

## Dashboard / Module Surfaces

- **Pipeline dashboard:** summary cards (pending #/$, funded #/$, expected pipeline value),
  Due-in-30-days (urgent ≤7d), In Prep, Awaiting Decision — reproduces the email digest live.
- **Grants table:** sortable/filterable by status, funder, year, due date.
- **Funders directory:** sortable/filterable CRM table; funder detail shows its linked grants
  + computed success rate / total awarded.
- **Prospecting worklist:** funders with an overdue/upcoming `Next Step Due`, grants in
  `To Research`, and RFP checks coming due.
- **Analytics view:** win-rate & $-by-year, success-rate-by-funder, pipeline forecast.

## Open Questions (resolve during planning)

1. **Migration matching:** the grants sheet references funders by free-text name (~65 distinct,
   often inconsistent spacing/casing). How aggressively do we fuzzy-match to the 203 funder
   records vs. leave unmatched grants with a typed-name fallback for manual linking?
2. **Email recipients:** who receives the monthly digest and per-deadline reminders — all
   `grants`-project members, or a configured list? Per-grant reminders to the relationship
   manager only?
3. **Pipeline-forecast weighting:** what probability weights per stage (e.g. Pending 50%,
   In Prep 20%)? Configurable or fixed defaults?
4. **Currency / amounts:** confirm everything is USD; how to handle blank/garbled amount
   strings from the sheet on import.
5. **Cron scheduling:** the digest fires monthly and reminders daily — confirm against the
   container-cron Eastern-timezone gotcha and the in-container XFF/Bearer auth gotcha.
6. **History fields** (`Last Modified`, `Last Notified`): import as-is or recompute going
   forward?

## Next Step

Run `/workflows:plan` to turn this into an implementation plan (it will auto-detect this
brainstorm).
