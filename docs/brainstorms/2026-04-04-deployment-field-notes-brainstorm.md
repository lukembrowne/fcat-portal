# Deployment Field Notes

**Date:** 2026-04-04
**Status:** Ready for planning

## What We're Building

A simple notes field on Biochoco deployments to capture field context — equipment issues, missing data explanations, environmental conditions, and other operational information that currently lives in emails and chat messages.

**Example use case:** Louise reports that site POT-009-V001's audio recorder wasn't recording because horse activity near the site displaced the batteries. This note explains why audio data is missing for that deployment period, so anyone reviewing the data later understands the gap.

## Why This Approach

- **Per deployment/visit** (not per site): Data gaps and equipment issues are time-bound. A horse displacing batteries affects V1, not V2. Attaching notes to specific deployments keeps context precise.
- **Single text field** (not a log): FCAT staff entering notes via the portal is a low-frequency activity. A simple textarea is sufficient — no need for threaded comments or timestamped entries.
- **New `fieldNotes` column** (not a separate table): Matches the existing `qaNotes` pattern. YAGNI — can migrate to a table later if audit trail becomes important.
- **SQLite DB** (not Google Sheet): Portal is the source of truth. No sync complexity. Works for deployments that aren't in the schedule yet.
- **Separate from `qaNotes`**: QA notes are camera-trap-specific (exclusion reasons, valid date adjustments). Field notes cover all sensors and operational context. A deployment could have an audio recorder issue (field note) but perfect camera trap data (no QA note needed).

## Key Decisions

1. **Scope:** Notes attach to a specific deployment/visit, not a site
2. **Authors:** FCAT staff via the portal web app (not field technicians via ODK)
3. **Format:** Single editable text field per deployment (2,000 character limit)
4. **Storage:** New `fieldNotes` text column on `biochoco_deployments` table
5. **Relationship to qaNotes:** Kept separate. `qaNotes` = camera trap QA. `fieldNotes` = general field/operational context
6. **Biochoco overview UI:** Editable in the overview site summary table (notes icon → inline editor). Visual indicator (filled vs empty icon) shows which deployments have notes
7. **Biochoco data UI:** Notes indicator also shown in the data upload table
8. **Camera trap UI:** Displayed read-only on deployment detail page alongside QA notes, so image reviewers see field context
9. **Google Sheet notes column:** Ignored — not used, not displayed
