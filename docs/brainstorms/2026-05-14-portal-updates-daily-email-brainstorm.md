---
date: 2026-05-14
topic: portal-updates-daily-email
---

# Portal Updates — Daily Activity Email

## What We're Building

A second daily email — separate from the existing BioChoco "data uploads" digest — that gives portal users a snapshot of analysis progress across the whole portal. It covers four categories per project: camera-trap ML jobs completed, camera-trap images verified, audio jobs completed (BirdNET, indices, sync, compression), and audio recordings/detections verified. Each project section includes a mini "top verificadores" leaderboard so the people doing annotation work get visible recognition.

It runs on a new cron route, sends to a new recipient list (`PORTAL_UPDATES_EMAILS`), and uses a 24-hour lookback window — no snapshot table needed.

## Why This Approach

The user wants a "snapshot of progress" decoupled from the data-uploads digest, with the same architecture (Resend + cron route + env-var recipient list). Almost all the data already exists:

- `system_events` table already records job-completion events via `buildJobCompletionEvent()`
- `identifications.verifiedAt` and `audio_identifications.verifiedAt` are already populated by the verify actions
- `verifiedBy` (email) is already stored, which powers the leaderboard

So the email is essentially a *read-only aggregation view* over existing data. No schema changes are required for v1.

We considered extending the nightly route or mirroring its `uploadCountSnapshots` pattern; a separate route with a 24-hour lookback was chosen for clean failure isolation and minimal new code.

## Key Decisions

- **Cadence:** Daily (e.g., 1 AM Eastern, like the existing nightly).
- **Scope:** All projects in one email, **grouped by project section** (BIOCHOCO, FCAT, …).
- **Verification metric:** Count of **distinct images / distinct audio files** newly verified in the window — not raw identification counts. Matches user intuition ("142 imágenes verificadas").
- **Categories included (v1):** CT ML jobs, CT images verified, audio jobs (all types), audio recordings/detections verified.
- **Per-user breakdown:** Mini leaderboard per project, per category (e.g., "Verificadas: 142 (Luke 80, María 62)"). Source: `verifiedBy` on the identification rows.
- **Recipients:** New `PORTAL_UPDATES_EMAILS` env var (CSV), parallel to `NIGHTLY_REPORT_EMAILS`. Independent audience.
- **Wiring:** New route at `src/app/api/cron/portal-updates/route.ts`. New crontab entry. Window = `WHERE timestamp >= now - 24h`. Queries `system_events` for jobs and `identifications` / `audio_identifications` for verifications directly — no new table.
- **Transport / template:** Resend (`RESEND_API_KEY`, `RESEND_FROM_EMAIL`), inline HTML builder, same pattern as `nightly-refresh/route.ts`.
- **Empty-window behavior:** If nothing happened in the last 24h, still send a "sin actividad nueva" email (or skip — TBD in plan).

## Data Sources (no schema changes needed)

| Metric | Query source |
|---|---|
| CT ML jobs completed | `processing_jobs` where `status='completed'` AND `completedAt >= cutoff` AND `jobType IN (ml-types)`, joined to project via deployment |
| CT images verified | `identifications` where `verifiedAt >= cutoff` AND `verificationStatus='verified'` → `COUNT(DISTINCT imageId)` per project |
| Audio jobs completed | `processing_jobs` filtered by `AUDIO_JOB_TYPES` from `src/lib/system-events.ts` |
| Audio files verified | `audio_identifications` where `verifiedAt >= cutoff` AND `verificationStatus='verified'` → `COUNT(DISTINCT audioFileId)` per project (via detection → file join) |
| Top verificadores | `GROUP BY verifiedBy` on the same queries, `ORDER BY count DESC LIMIT 3` |

`system_events` is also a viable source for jobs (it already captures completions) — choice between querying `processing_jobs` directly or `system_events` deferred to the planning phase.

## Open Questions

- **Project resolution for verifications:** Camera-trap and audio identifications belong to deployments → projects. Need to confirm the join path is fast enough at 24h scale (likely fine; deployments table is small).
- **Should we also `recordEvent()` a daily summary?** Optional enhancement: emit one `portal_updates.daily_summary` event per run so the run itself shows up in `/admin/activity`. Not blocking v1.
- **Empty-day behavior:** Send a "no hubo actividad" email, or skip the send entirely?
- **Per-project recipient overrides:** v1 uses a single CSV. If projects later want different audiences, we can add a recipients table — defer until requested.

## Next Steps

→ Run `/workflows:plan` to break this into implementation steps (route file, query helpers, HTML template, crontab entry, env-var docs, integration test, deploy notes).
