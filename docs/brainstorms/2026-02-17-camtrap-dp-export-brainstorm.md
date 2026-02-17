# Brainstorm: Camtrap DP Export for Camera Trap Module

**Date:** 2026-02-17
**Status:** Complete

## What We're Building

A data export feature on the main camera trap deployments page (`/camera-trap`) that generates a **Camtrap DP** (Camera Trap Data Package) compliant ZIP file. The ZIP contains:

- `deployments.csv` — one row per camera deployment (location, dates, site info)
- `media.csv` — one row per image (filename, timestamp, deployment link)
- `observations.csv` — one row per detection/identification + blank observation rows for images with no detections
- `datapackage.json` — package metadata (FCAT project info, licenses, spatial/temporal scope, taxonomic scope)

The standard is defined at https://camtrap-dp.tdwg.org/ and is widely used for camera trap data sharing and analysis.

## Why This Approach

- **Camtrap DP** is the TDWG-endorsed standard for camera trap data exchange. It's used by Wildlife Insights, GBIF, Agouti, and other major platforms.
- A multi-file ZIP with metadata is more useful than a flat CSV — it preserves relationships and is self-documenting.
- Server-side ZIP generation via an API route avoids client-side dependencies and handles large datasets cleanly.

## Key Decisions

### Export location and scope
- **Button on the main deployments page** (`/camera-trap`), integrated with the existing TanStack Table row selection.
- Users can export **selected deployments** or **all processed deployments**.
- The table already has row selection (checkboxes) — we'll reuse that.

### Which deployments to include
- **Only processed deployments** (status: `processed`, `verified`, `verified_empty`).
- Unscanned/scanning/processing deployments are excluded.
- **Show a clear message** about how many deployments are excluded and why (e.g., "3 instalaciones sin procesar no fueron incluidas").

### Missing coordinates
- **Include deployments with empty lat/lng** (technically non-compliant with Camtrap DP required fields, but pragmatic — the data is still useful).

### Handling rejected observations
- **Exclude rejected detections** entirely (these are confirmed false positives).
- For **corrected** identifications, use the corrected species as `scientificName`.
- For **unverified** identifications, use the ML-predicted species.
- Use `classificationMethod`: `"machine"` for unverified, `"human"` for verified/corrected.

### Empty images / blank observations
- Images with no detections get a single observation row with `observationType: "blank"`.
- Images with `confirmedBlank: true` also get `observationType: "blank"`.
- This supports occupancy modeling (presence/absence analysis).

### Implementation approach
- **Server-side API route** (`/api/camera-trap/export`) builds the ZIP using Node's built-in `zlib`/`archiver`.
- Accepts deployment IDs as query params.
- Returns a ZIP with `Content-Disposition: attachment` header.
- Permission check: `requirePermission("camera-trap", "viewer")` — read-only export.

## Data Mapping

### deployments.csv
| Camtrap DP field | Source |
|---|---|
| deploymentID | `deployment.id` (as string) |
| locationID | `deployment.siteName` |
| locationName | `deployment.name` |
| latitude | `deployment.latitude` |
| longitude | `deployment.longitude` |
| deploymentStart | `deployment.dateStart` (ISO 8601) |
| deploymentEnd | `deployment.dateEnd` (ISO 8601) |
| deploymentComments | `deployment.projectLabel` |

### media.csv
| Camtrap DP field | Source |
|---|---|
| mediaID | `image.id` (as string) |
| deploymentID | `image.deploymentId` (as string) |
| timestamp | `image.exifTimestamp` (ISO 8601) |
| filePath | `image.filename` |
| filePublic | `false` |
| fileName | `image.filename` |
| fileMediatype | `"image/jpeg"` |

### observations.csv
| Camtrap DP field | Source |
|---|---|
| observationID | `detection.id` or generated for blanks |
| deploymentID | via image → deployment |
| mediaID | `detection.imageId` (as string) |
| eventStart | `image.exifTimestamp` |
| eventEnd | `image.exifTimestamp` |
| observationLevel | `"media"` |
| observationType | `"animal"` / `"blank"` |
| scientificName | `COALESCE(correctedSpecies, species)` |
| count | `1` |
| bboxX/Y/Width/Height | detection bbox fields |
| classificationMethod | `"machine"` or `"human"` |
| classifiedBy | model version or verifiedBy |
| classificationProbability | `identification.confidence` |

### Video-extracted frames
- **Include** video-extracted frames in media.csv.
- Use `captureMethod: "activityDetection"` for video frames, distinguish via `mediaComments` noting source video filename and frame index.

### Bilingual README
- **Include a `README.md`** inside the ZIP with sections in English and Spanish.
- Explains the Camtrap DP format, FCAT-specific field mappings, and how to open the CSVs.

## Open Questions

- Future: should individual job result pages also get an export button?
