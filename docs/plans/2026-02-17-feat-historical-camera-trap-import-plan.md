---
title: "feat: Historical camera trap data import script"
type: feat
date: 2026-02-17
---

# Historical Camera Trap Data Import Script

## Overview

Create a standalone TypeScript script (`scripts/import-historical-camera-data.ts`) that enriches camera trap deployments and pre-fills species identifications using historical CSV data from 2014. The script runs **after** the normal Drive sync + MegaDetector pipeline, matching ML-generated bounding boxes with human-identified species labels.

No schema changes. No UI changes. One new script file.

## Problem Statement

~1900 historical camera trap videos from 2014 have been manually identified (species in filename) but never processed through MegaDetector. To use this data for training a species classifier, we need both real bounding boxes (from ML) AND correct species labels (from the historical CSV data). The standard pipeline gives us boxes; this script fills in the labels.

## Proposed Solution

A single `.ts` script (run via `npx tsx`) following the `import-species-csv.mjs` pattern: direct `better-sqlite3` connection, CSV parsing with `csv-parse/sync`, transaction-based updates, detailed console logging.

### Prerequisites (user does manually before running script)

1. Copy TP-xxx folders to the camera trap Google Drive root
2. Run Drive sync from the portal UI (creates deployments, scans images/videos)
3. Process each deployment through MegaDetector (creates detections + identifications)

### What the script does

1. **Backup DB** — Run `node scripts/backup-db.mjs` (or warn if skipped)
2. **Parse CSVs** — Load Camera_log + species detection data CSVs, build lookup maps
3. **Match & enrich deployments** — Find portal deployments by TP code, set lat/lng (UTM→WGS84 via `proj4`), dateStart, dateEnd
4. **Match detections & pre-fill species** — For each CSV detection row, find the video→images→detections chain, update identifications with historical species
5. **Report** — Print summary with unmatched filenames for debugging

## Technical Approach

### File: `scripts/import-historical-camera-data.ts`

Follows the `import-species-csv.mjs` pattern but in TypeScript:
- Direct `better-sqlite3` connection (not Drizzle ORM — standalone script)
- Two transactions: one for deployment enrichment, one for identification updates
- `DB_PATH` env var support, defaults to `data/portal.db`
- Run via `npx tsx scripts/import-historical-camera-data.ts`

### Dependencies

- `csv-parse` — Proper CSV parsing (handles quoted fields with commas in location descriptions). Use `csv-parse/sync` for simplicity.
- `proj4` — UTM Zone 17N → WGS84 conversion. One line vs ~30 lines of error-prone hand-rolled geodetic math.

Install as dev dependencies: `npm install --save-dev csv-parse proj4 @types/proj4`

### CLI Flags

```
npx tsx scripts/import-historical-camera-data.ts [options]

Options:
  --dry-run              Print what would change without writing
  --deployment TP-062    Process only one deployment (for debugging)
```

No `--csv-dir` flag — hardcode the path to the BioChoco repo CSV directory.

### Phase 1: Parse CSVs + Build Maps

Start with just 2 CSVs:
- **`Camera_log 2015_01_12.csv`** — deployment metadata (coordinates, dates)
- **`species detection data 2020_03_17(in).csv`** — species identifications (cleaner scientific names)

Add `camera data.csv` + `historical_species_mapping.csv` fallback only if the ~140 uncovered rows matter after the first run.

```typescript
import { parse } from 'csv-parse/sync';

// Build lookup maps
const deploymentMeta: Map<string, { utmEasting: number, utmNorthing: number, datePlaced: string, dateRemoved: string }>;
const detectionsByTP: Map<string, Array<{ filename: string, species: string, count: number, date: string, exclude?: boolean, problem?: string }>>;
```

**Date normalization**: 2014 CSVs may have inconsistent date formats — normalize to ISO 8601 during parsing.

**Skip rows**: Skip rows where `Exclude = 1`. Log rows where `Problem` column has a value (but still process them).

**Multi-species per video**: Check if the same video filename appears in multiple CSV rows with different species. If so, each row maps to a different detection on that video.

### Phase 2: Match & Enrich Deployments

```sql
-- One query to get all deployments
SELECT id, name FROM biochoco_deployments
WHERE project_id = 'camera-trap'
```

Match by extracting TP code from deployment name (regex `/TP-\d+/`).

For each matched deployment with Camera_log metadata:
- Convert UTM Zone 17N to lat/lng using `proj4`:
  ```typescript
  import proj4 from 'proj4';
  const utm17n = '+proj=utm +zone=17 +datum=WGS84 +units=m +no_defs';
  const wgs84 = '+proj=longlat +datum=WGS84 +no_defs';
  const [lng, lat] = proj4(utm17n, wgs84, [easting, northing]);
  ```
- Update `latitude`, `longitude`, `date_start`, `date_end`

**Transaction 1**: All deployment updates in one transaction.

### Phase 3: Match Detections & Pre-fill Species

**One JOIN query per deployment** (not 3 queries per CSV row):

```sql
-- Get all videos → images → detections for a deployment at once
SELECT
  v.id as video_id, v.filename as video_filename,
  img.id as image_id,
  d.id as detection_id, d.detection_confidence, d.detection_class,
  i.id as ident_id, i.species as ml_species, i.verification_status
FROM biochoco_videos v
JOIN biochoco_images img ON img.video_id = v.id
JOIN biochoco_detections d ON d.image_id = img.id
JOIN biochoco_identifications i ON i.detection_id = d.id
WHERE v.deployment_id = ?
  AND d.detection_class = 0  -- animals only
  AND i.verification_status = 'unverified'
ORDER BY v.filename, d.detection_confidence DESC
```

Build a JS lookup map: `Map<videoFilename, Array<{ detectionId, identId, confidence, mlSpecies }>>`.

Then for each CSV detection row in this deployment:
1. Find video by filename match (case-insensitive)
2. Get the detection list from the lookup map
3. Take `detections.slice(0, csvCount)` — assign species to the top N by confidence
4. If count mismatch, log a warning

**Species update logic**:
- If ML species matches historical species → `verification_status = 'verified'`
- Otherwise → `corrected_species = historicalSpecies`, `verification_status = 'corrected'`
- Both set `verified_by = 'historical-import'`, `verified_at = unixepoch()`

**Transaction 2**: All identification updates in one transaction.

### Reporting

Print a structured summary:
```
Historical Camera Trap Import Summary
======================================
Deployments: 120 matched, 5 unmatched
  Enriched with coordinates: 95
  Enriched with dates: 110
Detections: 1650 matched, 133 unmatched
  Verified (ML matched): 320
  Corrected (species updated): 1330
  Skipped (excluded): 45
  Warnings (count mismatch): 87

Unmatched deployments:
  - TP-145 (not found in DB)
  - TP-198 (not found in DB)

Unmatched filenames (first 20):
  - TP-062: IMG_0099 unknown.AVI (no video row found)
  - TP-063: IMG_0145 paca two.AVI (no detections on video)
```

## Acceptance Criteria

- [x] Script parses CSV files without errors (using `csv-parse/sync`)
- [x] Deployments matched by TP code in name, enriched with lat/lng and dates
- [x] UTM Zone 17N → WGS84 conversion via `proj4` produces coordinates near FCAT (~0.3°N, ~-79.7°W)
- [x] Video filenames matched to detection rows through video → image → detection chain
- [x] Identifications updated with `correctedSpecies` and `verificationStatus`
- [x] Only updates `unverified` identifications (won't overwrite manual corrections)
- [x] Excluded rows (Exclude=1) skipped; Problem rows logged but processed (N/A — species detection CSV has no Exclude/Problem columns; applies when camera data.csv fallback is added)
- [x] Dry-run mode (`--dry-run` flag) that prints what would change without writing
- [x] `--deployment TP-062` filter for debugging single deployments
- [x] Script is idempotent (safe to run multiple times — only updates `unverified` rows)
- [x] Detailed console output with match/skip/warning counts + unmatched filenames
- [x] DB backup step before mutations
- [x] `verified_by = 'historical-import'` doesn't break any UI lookups

## Implementation Phases

### Phase 1: Script Skeleton + CSV Parsing + Deployment Enrichment

**Files**: `scripts/import-historical-camera-data.ts`

- [x] Install deps: `npm install --save-dev csv-parse proj4 @types/proj4`
- [x] Create script with `better-sqlite3` DB connection pattern
- [x] Parse 2 CSVs with `csv-parse/sync` (Camera_log + species detection data)
- [x] Build lookup maps (deployment metadata, detections by TP)
- [x] Normalize dates to ISO 8601
- [x] Add `--dry-run` and `--deployment` flag support via `process.argv`
- [x] Query all camera-trap deployments, match by TP code regex
- [x] Convert UTM Zone 17N → WGS84 via `proj4`
- [x] Update matched deployments with lat/lng, dateStart, dateEnd (Transaction 1)
- [x] Add backup step: call `node scripts/backup-db.mjs` or warn
- [x] Log matched/unmatched deployment names

### Phase 2: Detection Matching + Species Pre-fill + Reporting

- [x] For each matched deployment, run one JOIN query to get all videos→images→detections
- [x] Build filename→detections lookup map in JS
- [x] For each CSV detection row, match by filename, assign species to top N detections
- [x] Handle multi-species per video (same filename, different species in CSV)
- [x] Update identifications: verified if ML matches, corrected otherwise (Transaction 2)
- [x] Skip Exclude=1 rows, log Problem rows (N/A for species detection CSV)
- [x] Print final summary report with unmatched filenames

### Phase 3: Testing + Validation

- [x] Run with `--dry-run` on production DB copy to verify matching
- [x] Run with `--deployment TP-062` to validate a single deployment end-to-end
- [ ] Spot-check a few deployments in the portal UI after import
- [x] Verify UTM conversion produces sensible coordinates
- [ ] Verify `verified_by = 'historical-import'` renders correctly in the annotation UI

## Key Patterns to Follow

| Pattern | Source | Notes |
|---------|--------|-------|
| Direct `better-sqlite3` | `scripts/import-species-csv.mjs` | Not Drizzle — standalone script |
| Transaction wrapping | `scripts/import-species-csv.mjs:82` | Two transactions (deploy + ident) |
| WAL mode + foreign keys | `scripts/push-schema.mjs:26-27` | `db.pragma("journal_mode = WAL")` |
| Species as text strings | `src/db/schema.ts:279` | `identifications.species` is TEXT, not FK |
| Verification pattern | `src/app/camera-trap/actions.ts:1791` | `correctedSpecies` + `verificationStatus` |
| UTM Zone 17N | `src/app/biochoco/overview/schedule-table.tsx:141` | `toUtm17N()` confirms zone |
| CSV parsing | `csv-parse/sync` | Handles quoted fields, commas in values |
| UTM conversion | `proj4` | One-liner, battle-tested library |

## References

- Brainstorm: `docs/brainstorms/2026-02-17-historical-camera-trap-import-brainstorm.md`
- Existing import script: `scripts/import-species-csv.mjs`
- Schema: `scripts/push-schema.mjs` (raw SQL definitions)
- Verification actions: `src/app/camera-trap/actions.ts` (correctIdentification, assignSpecies patterns)
- CSV data: `/Users/luke/apps/BioChoco/.worktrees/camera-trap-integration/data/historical_camera_data/`
