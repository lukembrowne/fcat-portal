# iButton Temperature Data Dashboard

**Date:** 2026-02-24
**Status:** Brainstorm complete

## What We're Building

A temperature data processing pipeline and visualization dashboard for iButton sensor data collected during BIOCHOCO deployments. The system will:

1. **Pull iButton .xlsx files from Google Drive** — Each deployment already has an `ibutton` subfolder in its Drive folder. The system fetches files from there automatically.
2. **Parse and store readings in a new DB table** — An `ibutton_readings` table stores individual temperature readings linked to deployments, truncated to the deployment's actual install/retrieve time window.
3. **Display a Temperatura dashboard** — A new `/biochoco/temperature` page with habitat-level summary cards and comparison charts, plus drill-down to individual deployment time-series.
4. **Support manual data review** — Users visually inspect charts and can flag bad data. No automated anomaly detection for MVP.

## Why This Approach

- **Pull from Drive** rather than manual upload because the files are already organized in Drive folders by the existing datos workflow. One less step for users.
- **Store in DB** rather than parse on-the-fly because fast dashboard queries require indexed data, and aggregating across 100+ deployments from Drive API on every page load would be unacceptably slow.
- **Batch processing** rather than per-deployment because the initial import needs to handle many deployments at once, and a single "Process All" button is simpler than clicking through each deployment.
- **Manual review** rather than auto-flagging because researchers know their data best, and building reliable anomaly detection for tropical microclimate data is non-trivial. Better to show the data clearly and let humans decide.

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Data ingress | Pull from Google Drive ibutton subfolders | Files already organized there by datos workflow |
| Storage | New `ibutton_readings` DB table | Fast queries, supports summaries + drill-down |
| UI location | New `/biochoco/temperature` nav page | Dedicated space, doesn't crowd datos page |
| Processing | Batch — "Process All" button | Efficient for bulk import of many deployments |
| Dashboard | Summary cards + habitat comparison, drill-down to deployment | Covers both overview and detail needs |
| Data QA | Manual visual review (no auto-flagging) | Simpler, relies on researcher expertise |
| Anomaly detection | Not for MVP | Can add later if patterns emerge |
| Data export | Not for MVP | Researchers can access raw files in Drive |

## Data Model

### iButton File Structure (.xlsx)

```
Header rows (18 lines):
  - DatalogID, Device Part Number, Serial Number
  - Mission Start Time, Sample Rate (e.g., 30 min)
  - Roll Over flag, Sample Count, Data Unit (degrees C)
  - Alarm thresholds (high/low)

Data rows:
  Date        Time      Value
  2026-01-19  15:53:00  25.875
  2026-01-19  16:23:00  25.125
  ...
```

### New DB Table: `ibutton_readings`

- `id` — primary key
- `deploymentId` — FK to `biochoco_deployments`
- `timestamp` — reading datetime (UTC-5 as recorded)
- `temperatureC` — temperature in degrees Celsius
- `flagged` — boolean, manually flagged as suspect by user

### New DB Table: `ibutton_uploads`

- `id` — primary key
- `deploymentId` — FK to `biochoco_deployments`
- `filename` — original filename from Drive
- `deviceSerial` — iButton serial number from file header
- `sampleRate` — e.g., "30 minutes"
- `missionStart` — mission start time from file header
- `rowsImported` — count of readings stored
- `dateRangeStart` / `dateRangeEnd` — actual data range after truncation
- `processedAt` — timestamp
- `processedBy` — user email

## Processing Pipeline

1. User clicks "Procesar iButton" on the Temperatura page
2. System queries all deployments with `upload_ibutton_count > 0` that haven't been processed yet
3. For each unprocessed deployment:
   a. Fetch .xlsx file(s) from the Drive ibutton subfolder
   b. Parse header (device serial, sample rate, mission start)
   c. Parse data rows (date, time, temperature)
   d. Look up deployment's actual install/retrieve dates from ODK submissions
   e. Truncate readings to the deployment time window
   f. Insert into `ibutton_readings` within a transaction
   g. Record upload metadata in `ibutton_uploads`
4. Revalidate the Temperatura page

## Dashboard Views

### Summary View (main page)
- **Summary cards**: Total deployments processed, total readings, date range covered
- **Habitat comparison chart**: Box plot or grouped bar chart showing temperature distribution (min/mean/max) by habitat type
- **Deployments table**: List of all processed deployments with sparkline, site, habitat, date range, reading count. Sortable/filterable.

### Deployment Drill-Down (click a deployment)
- **Time-series line chart**: Temperature over time with the deployment window highlighted
- **Stats panel**: Min, max, mean, std dev, reading count, sample rate
- **Device info**: Serial number, mission start, file processed
- **Manual flagging**: Users can click to flag/unflag individual readings or time ranges as suspect

## Existing Patterns to Follow

- **Climate module**: Upload → parse → preview → commit pipeline, `climate_readings` table structure, Recharts dashboard with aggregation
- **Camera-trap processing**: Batch processing with progress tracking, Drive file download
- **Drive client**: `checkDeploymentUploads()` pattern for accessing deployment subfolders
- **Recharts**: `ResponsiveContainer` + `LineChart` with `dot={false}` for dense time-series

## Resolved Questions

1. **One iButton file per deployment** — Single .xlsx file per deployment. No need to handle multiple files for now.
2. **Timezone: Ecuador local time (UTC-5)** — Store timestamps as-is from the file. Ecuador is permanently UTC-5 (no DST), and the iButton already records in UTC-05:00. Consistent with the climate module.
3. **Reprocessing** — Include a "Reprocesar" button per deployment. Deletes old readings and re-imports from the current Drive file. Useful if someone uploads a corrected file.
4. **Habitat type** — Sourced from the ODK site entity's `habitat_type` field, which is reliably set for all sites.
