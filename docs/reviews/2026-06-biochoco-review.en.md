# BioChocó Data Review — June 2026
_Generated: 2026-06-17 · 64 deployments reviewed (2 excluded) · **live Drive re-count**_

## Executive summary
- 🔴 Errors: 3   🟡 Warnings: 27   🔵 Info: 11
- 35 of 64 deployments have at least one finding. Lifecycle status: 58 retrieved, 6 installed (still in the field), 0 pending installation.
- **Priority actions this month:**
  1. **Upload / verify the data for PRI-003 and NAC-007** — retrieved (6 and 4 days ago) but nothing in Drive. Recent, so likely just needs uploading; confirm with the field team.
  2. **Retrieve POT-008** (installed, **23 days** overdue for retrieval — risk of battery/card loss).
  3. **Check REF-003's camera clock** (180 images outside the window) and the **very low iButton coverage on GIZ-012 (38%)**.

## Comparison with the previous month
- First review — no prior report to compare against. This report stands as the **baseline**; from next month on, findings will be marked as new / persistent / resolved.

## 1. Overdue retrieval
Installed, not yet retrieved, with the cronograma's retrieval date already passed.

| Deployment | Habitat | Planned retr. | Days overdue | Severity |
|---|---|---|---|---|
| POT-008_V1 | pasture | 2026-05-25 | 23 | 🔴 |
| GIZ-013_V1 | cacao GIZ | 2026-06-14 | 3 | 🟡 |
| CCN-007_V1 | cacao CCN | 2026-06-15 | 2 | 🟡 |
| REF-013_V1 | reforestation | 2026-06-16 | 1 | 🟡 |

> **Recommended action:** prioritize **POT-008** (3 weeks overdue). The other three only just slipped (1–3 days); reschedule for the next field trip.

## 2. Overdue installation
No findings: no scheduled deployment was left uninstalled past its date. ✅

## 3. Retrieved with no data
Sensors retrieved (`retrieve_sensors` present) but with **zero** camera, audio, and iButton files in Drive after the live re-count.

| Deployment | Habitat | Retr. date | Days since retr. | Severity |
|---|---|---|---|---|
| PRI-003_V1 | primary forest | 2026-06-11 | 6 | 🔴 |
| NAC-007_V1 | cacao nacional | 2026-06-13 | 4 | 🔴 |

> **Recommended action:** both are recent — most likely the cards/recorders exist and just need uploading. Upload them and, if they don't appear, check for a field failure.

## 4. Partial upload
Retrieved with some data types present and others missing (expected types inferred from the existing Drive subfolders).

| Deployment | Habitat | Present | Missing | Counts (cam / audio / iBtn) |
|---|---|---|---|---|
| POT-009_V1 | pasture | cameras, iButton | audio | 1728 / 0 / 1 |
| CCN-004_V1 | cacao CCN | cameras, audio | iButton | 1476 / 5578 / 0 |
| POT-011_V1 | pasture | audio, iButton | cameras | 0 / 5451 / 1 |

> **Recommended action:** confirm whether the missing type was actually deployed at that site. "Missing audio" (POT-009) may mean no recorder was installed there. "Missing cameras" (POT-011) — check whether the camera captured nothing (like CCN-005, see field notes) or the photos weren't uploaded. CCN-004 ("missing iButton") has camera and audio — verify whether the iButton was retrieved.

## 5. Missing coordinates
No findings: all reviewed deployments have latitude/longitude. ✅

## 6. Unverifiable counts (Drive errors)
No findings: the live re-count completed without errors across all 64 deployments (0 failures). ✅

## 7. Files outside the deployment window
Camera images with a timestamp outside the install→retrieve range.

| Deployment | Habitat | Window | Images outside | Severity |
|---|---|---|---|---|
| REF-003_V1 | reforestation | 2026-04-17 → 2026-05-17 | **180** | 🟡 |
| POT-010_V1 | pasture | 2026-04-18 → 2026-05-18 | 2 | 🟡 |
| SEC-007_V1 | secondary forest | 2026-02-22 → 2026-03-23 | 1 | 🟡 |

> **Recommended action:** **REF-003** with 180 images outside the window suggests a **misconfigured camera clock** — fix it before it contaminates the temporal analyses. POT-010 (2) and SEC-007 (1) are trivial (probably install/retrieve test photos).

## 8. Processing health (iButton / ML)

### Failed processing jobs
| Deployment | Habitat | Failed jobs |
|---|---|---|
| REF-010_V1 | reforestation | 3 |
| REF-002_V1 | reforestation | 1 |
| SEC-008_V1 | secondary forest | 1 |
| NAC-008_V1 | cacao nacional | 1 |
| GIZ-009_V1 | cacao GIZ | 1 |
| CCN-012_V1 | cacao CCN | 1 |
| PRI-004_V1 | primary forest | 1 |

> **Recommended action:** retry the ML processing for these (none report individual failed images, so they were likely whole-job failures — disk, download, or cancellation). REF-010 has 3 — check it first.

### Low iButton coverage (<95%)
| Deployment | Habitat | Coverage | Readings |
|---|---|---|---|
| GIZ-012_V1 | cacao GIZ | **38%** | 559 |
| CCN-013_V1 | cacao CCN | 57% | 845 |
| SEC-014_V1 | secondary forest | 67% | 1002 |
| POT-003_V1 | pasture | 75% | 1050 |
| NAC-012_V1 | cacao nacional | 76% | 1128 |
| GIZ-010_V1 | cacao GIZ | 76% | 1099 |
| NAC-011_V1 | cacao nacional | 77% | 1149 |
| CCN-008_V1 | cacao CCN | 78% | 1134 |
| PRI-006_V1 | primary forest | 89% | 1323 |
| SEC-003_V1 | secondary forest | 90% | 1335 |

> **Recommended action:** GIZ-012 (38%) and CCN-013 (57%) have large gaps in the temperature series — check whether the sensor failed mid-deployment or the mission was configured with a different range. The 89–90% ones are acceptable. The 75–78% cluster (several deployments) is worth looking at together: it could be a mission-configuration pattern rather than individual failures.

### Awaiting human verification (info)
11 deployments processed by ML but without human verification of detections: NAC-002, SEC-007, GIZ-004, CCN-004, PRI-006, NAC-012, CCN-013, REF-003, PRI-013, SEC-012, SEC-009.

> Not a data problem, but a verification work queue. Useful for planning the team's review time.

## Findings explained by field notes
- **CCN-005_V1** — _Partial upload: missing cameras_ (audio 5146, iButton 1, cameras 0). **Field note:** _"had no photos, was 0/0"_. Explained: the camera captured no images in the field; this is not an upload failure. Keep as a record, no upload action needed.

## Appendix — methodology and sources
- **Sources:** cronograma (Google Sheets), ODK (`instalar_sensores` / `retrieve_sensors`), Google Drive file counts (**live re-count**), portal database.
- **Drive count:** this report forced a live re-count of all 64 deployments (completed in ~1.5 min, 0 errors). Important: a cached-count run would have produced false positives (e.g. POT-010 and POT-003 showed 0 from stale cache when they actually have data).
- **Thresholds:** overdue >14 days = error, ≤14 days = warning; iButton coverage <95% = low.
- **v1 scope:** "files outside window" is evaluated for camera images only; window QC for audio/iButton is deferred. Coordinate plausibility (bounding box) is deferred; v1 only flags null coordinates. Expected types (partial uploads) are inferred from existing Drive subfolders.
- **Excluded deployments (QA):** 2, omitted from findings.
- **Snapshot:** `data/reviews/snapshot-2026-06.json`
