---
date: 2026-04-08
topic: ibutton-deployment-window-coverage
---

# iButton — Display Deployment Window & Coverage

## What We're Building

The Temperatura (iButton) section needs to clearly surface the **ODK-recorded
deployment window** (install datetime → retrieval datetime) alongside the raw
iButton timeline, and show a **coverage metric** that tells the user whether
the sensor actually recorded readings across the full window. Because iButton
sensor clocks can drift relative to the field tech's phone clock (source of
ODK timestamps), a mismatch between the declared window and actual readings is
expected and should be surfaced — not corrected.

The existing ingest-time truncation in `src/app/biochoco/ibutton/actions.ts`
(lines 248-269) stays in place: raw readings are already preserved in Google
Drive, so dropping out-of-window readings from the portal DB is acceptable.

## Why This Approach

Considered and rejected:
- **Auto-correcting clock skew** — too risky; a bad ODK entry could corrupt
  an entire deployment.
- **Storing all raw readings + display-time filter** — unnecessary because
  raw CSVs persist in Drive. Adds DB bloat for no gain.
- **Moving UI into /biochoco/resultados/[siteId]** — scope creep. Site-level
  page is for aggregates; deployment-level QA belongs near deployment data.

Chosen: keep ingest behavior, focus on **visibility and completeness
signaling** in the two places the user actually looks at iButton data.

## Key Decisions

- **Ingest truncation stays** — raw data lives in Drive; portal stores the
  in-window subset.
- **Coverage = time-based gap detection** — expected readings computed from
  `sample_rate` (already in `ibutton_uploads`) × ODK window duration; coverage
  % = actual / expected. Also report **largest gap** (the longest stretch with
  no readings) so users can distinguish "sensor died mid-deployment" from
  "minor dropouts".
- **Low-coverage threshold: < 95%** — warn the user with a badge.
- **Two placements**:
  1. **Temperatura deployments table** (`deployments-table.tsx`) — add ODK
     install/retrieve datetime columns, coverage %, and a warning badge.
  2. **iButton deployment detail page** (`/biochoco/ibutton/[id]`) — show ODK
     window vs. actual reading window, coverage %, largest gap, and annotate
     the temperature line chart with vertical markers for ODK install &
     retrieve times.
- **No changes to site resultados page** (`/biochoco/resultados/[siteId]`).
- **No auto-correction of clock skew** — purely observational metric.

## Open Questions

- **Missing ODK time-of-day**: current code defaults to `00:00:00` / `23:59:59`
  when `deploy_time` / `retrieval_time` are empty (`actions.ts:74, 96`). Should
  the UI show these as "time unknown" rather than precise, so users don't
  mistake a padded window for ground truth? (Likely yes — flag in plan phase.)
- **Persist coverage or compute on read?** Coverage can be computed cheaply
  from `ibutton_uploads.rows_imported`, `sample_rate`, `date_range_start/end`
  plus ODK window. Persisting adds a migration; computing on read is simpler.
  Recommend: compute on read, cache in action response.
- **Largest gap precision**: do we need a full scan of `ibutton_readings` to
  detect interior gaps, or is `expected vs actual count` enough to catch
  issues? Full scan gives a better signal but costs a query per row. Defer
  decision to planning phase.
- **Where do we get ODK install/retrieve datetimes for already-uploaded
  deployments?** The ODK maps are built on demand in `loadOdkDateTimes()`;
  values aren't persisted on the `deployments` row. Either persist them
  (small migration: add `odk_deploy_at` / `odk_retrieve_at` columns) or
  re-fetch ODK submissions on every table render (slow). Recommend: persist.

## Next Steps

→ `/workflows:plan` for implementation details.
