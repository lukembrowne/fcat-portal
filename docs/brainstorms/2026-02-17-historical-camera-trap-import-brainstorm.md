# Historical Camera Trap Data Import (2014)

**Date**: 2026-02-17
**Status**: Ready for planning

## What We're Building

A post-processing import script that integrates ~1900 historical camera trap detections from 2014 into the existing portal. The script runs **after** the normal Drive sync + MegaDetector pipeline, marrying ML-generated bounding boxes with human-identified species labels from CSV data.

## Why This Approach

The historical data has species identifications but no bounding boxes. The current system needs both for the annotation UI and for future model training. By running the standard pipeline first (Drive sync → scan → MegaDetector), we get real bounding boxes. Then the import script matches CSV species labels to the ML-detected boxes, effectively pre-verifying identifications.

This avoids any schema changes or special-case code in the main pipeline.

## Data Sources

### CSV Files (in BioChoco repo)

1. **`Camera_log 2015_01_12.csv`** (266 rows) — Deployment metadata
   - Trapping period (TP-001 through TP-207+), camera number, location name
   - UTM coordinates (need conversion to lat/lng), elevation
   - Dates placed/removed, trap nights
   - Project descriptions, habitat notes

2. **`camera data.csv`** (1923 rows) — Detection-level data with deployment info merged
   - Trapping period, filename, species code, count, date
   - Duplicate deployment fields (coordinates, habitat data)
   - Contains `Exclude` and `Problem` flags for data quality

3. **`species detection data 2020_03_17(in).csv`** (1783 rows) — Cleaner detection table
   - Trapping period, date, scientific name, class (mammal/bird), count, filename
   - More standardized species names than `camera data.csv`

4. **`historical_species_mapping.csv`** (49 entries) — Code translation
   - Maps filename codes (e.g., "rfw", "obqd", "agouti") to current species IDs and scientific names

### Media Files

- ~1900+ AVI video files organized into folders by trapping period (TP-062, TP-063, etc.)
- Currently on local disk, will be copied to the camera trap Google Drive root folder
- Filenames contain species codes: `IMG_0035 jaguarundi one.AVI`

## Workflow (Step by Step)

### Step 1: Manual — Copy folders to Drive
User copies TP-xxx folders into the camera trap root folder on Google Drive.

### Step 2: Normal Drive Sync
Standard `syncWithDrive()` creates deployments for each TP folder, scans images/videos.

### Step 3: ML Processing
Run MegaDetector on each deployment through the normal job queue. This:
- Extracts frames from AVI videos
- Generates bounding boxes for detected animals
- Creates detection + identification rows (with ML-predicted species)

### Step 4: Import Script (new)
A Node.js script (`scripts/import-historical-camera-data.ts`) that:

1. **Load CSV data**: Parse all three CSVs and the species mapping
2. **Match deployments**: Find portal deployments by name matching TP codes from folder names
3. **Enrich deployments**: Update lat/lng (UTM→WGS84 conversion), dateStart/dateEnd from Camera_log
4. **Match files to detections**:
   - For each CSV row, find the corresponding image/video row by filename within the deployment
   - For videos: match to extracted frame images (linked via `videoId`)
   - Find the ML-generated detection(s) on that image
5. **Pre-fill species**:
   - Map the CSV species code through `historical_species_mapping.csv` to get the scientific name
   - For each detection's identification: set `correctedSpecies` to the mapped name, `verificationStatus` to "corrected", `verifiedBy` to "historical-import"
   - If the ML prediction already matches the historical species, set `verificationStatus` to "verified" instead
6. **Handle count mismatches**: The CSV has an animal count per file. If MegaDetector found a different number of detections, log a warning for manual review.

## Key Decisions

1. **Use existing pipeline** — No schema changes. Drive sync, scanning, and ML processing all work as-is.
2. **Run MegaDetector for real bounding boxes** — Needed for future species classifier training.
3. **Post-ML species matching** — Script runs after ML to override/verify species predictions with historical labels.
4. **Coordinates only** — Convert UTM to lat/lng for deployment enrichment. Habitat metadata (canopy, slope, etc.) not imported for now.
5. **`species detection data` as primary** — Use the 2020 CSV (cleaner scientific names) as the primary source, fall back to `camera data.csv` + mapping for files not in that CSV.

## Open Questions

- **UTM Zone**: Need to confirm the UTM zone for coordinate conversion (likely Zone 17N for western Ecuador).
- **Folder name format**: Verify that Drive folder names match TP codes exactly (e.g., "TP-062" not "TP062" or "Trapping Period 62").
- **Blank/excluded videos**: The `camera data.csv` has `Exclude` and `Problem` columns. Should excluded files be skipped by the import script or imported and flagged?
- **Multi-detection matching**: When MegaDetector finds 3 animals in a video frame but the CSV says 2, which detections get the species label? (Probably: label the highest-confidence ones, leave extras for manual review.)

## Not Building

- No UI changes — the annotation interface works as-is with this data
- No special "historical" flag or filter in the UI (deployments are distinguishable by date)
- No habitat metadata storage
- No automated Drive copy — user handles file transfer manually
