# Nightly BioChoco Data Refresh & Email Report

## Overview

Automate the "Actualizar Conteo" process that currently runs manually from `/biochoco/data`. A nightly cron script refreshes Google Drive file counts for all BioChoco deployments, saves a daily snapshot, and sends a summary email via Resend.

## Architecture

### Script: `scripts/nightly-data-refresh.ts`

A standalone Node.js script executed by the Docker container's cron daemon. It imports project modules directly (no HTTP, no server actions, no auth checks).

**Execution flow:**

1. Query DB for all deployments with a non-null `driveFolderId`
2. For each deployment, call `checkDeploymentUploads(folderId)` from `src/lib/drive-client.ts`
3. On success: update the `deployments` table with new counts, subfolder IDs, and `uploadCountsCheckedAt`
4. On failure: log the error, record it in results, continue to next deployment
5. After all deployments: save a daily snapshot to `upload_count_snapshots` (upsert on today's date)
6. Compare today's totals against yesterday's snapshot for deltas
7. Send summary email via Resend
8. Log final status and elapsed time

**Key difference from server actions:** No `requirePermission()` calls. This is a system-level job, not a user request.

**Concurrency:** Process deployments sequentially (same as the manual refresh) to avoid Drive API rate limits. Each deployment makes 1 folder-check + up to 3 recursive file-count calls.

### Dependencies

- `resend` npm package (new)
- Existing: `drive-client.ts`, `db`, `schema.ts`

## Email Report

**From:** `portal@fcat-ecuador.org` (configurable via `RESEND_FROM_EMAIL`)

**To:** Comma-separated list from `NIGHTLY_REPORT_EMAILS` env var

**Subject:** `BioChoco Datos — Resumen nocturno YYYY-MM-DD`

**Body (HTML, inline styles):**

1. **Status line** — "Completado" or "Completado con errores (N fallos)"
2. **Summary table:**
   - Total cameras / audio / iButton file counts
   - Delta from yesterday (e.g. `+12 nuevos`)
   - Deployments with uploads: `X de Y`
3. **Per-deployment table:**
   - Columns: Deployment ID, Site, Cameras, Audio, iButton
   - Rows with new files since yesterday highlighted
   - Only deployments that have at least one file, sorted by deployment ID
4. **Errors section** (conditional) — table of deployment ID + error message for any failures

No templating library. Plain HTML string with inline CSS for email client compatibility.

## Scheduling

**Crontab addition** in `scripts/crontab`:

```
# Nightly BioChoco data refresh + email report (midnight Ecuador / 05:00 UTC)
0 5 * * * root cd /app && /usr/local/bin/npx tsx scripts/nightly-data-refresh.ts >> /app/data/nightly-refresh.log 2>&1
```

This runs alongside the existing hourly backup job. The crontab is installed to `/etc/cron.d/portal-backup` by `docker-entrypoint.sh`.

## Configuration

| Env var | Required | Default | Description |
|---------|----------|---------|-------------|
| `RESEND_API_KEY` | Yes | — | Resend API key for sending emails |
| `NIGHTLY_REPORT_EMAILS` | Yes | — | Comma-separated recipient emails (e.g. `lukebrowne@fcat-ecuador.org`) |
| `RESEND_FROM_EMAIL` | No | `portal@fcat-ecuador.org` | Sender email address |

These must be available inside the Docker container. Add to `docker-compose.yml` environment section or `.env` file.

## Logging

Output goes to `data/nightly-refresh.log` (persisted via Docker volume).

Log entries include:
- Job start timestamp
- Per-deployment: deployment ID, counts found, or error
- Snapshot saved confirmation
- Email send status (success or error)
- Total elapsed time

## Error Handling

- **Per-deployment failure** (Drive folder deleted, API error, rate limit): Skip, log error, continue. Include in email error section.
- **DB connection failure**: Script exits with non-zero code. Cron logs the error.
- **Resend API failure**: Log the error. The counts are still updated in DB even if the email fails.
- **No deployments found**: Send email noting zero deployments, don't treat as error.

## Files Changed

| File | Change |
|------|--------|
| `scripts/nightly-data-refresh.ts` | New — main script |
| `scripts/crontab` | Add nightly job line |
| `package.json` | Add `resend` dependency |
| `docker-compose.yml` | Add `RESEND_API_KEY`, `NIGHTLY_REPORT_EMAILS`, `RESEND_FROM_EMAIL` env vars |
