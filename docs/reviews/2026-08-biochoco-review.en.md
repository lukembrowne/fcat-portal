# BioChocó Data Review — August 2026
_Generated: 2026-08-10 · 92 deployments reviewed (0 excluded) · **live Drive re-count** · includes extended audit beyond the 8 standard checks_

## Executive summary
- 🔴 Errors: 2   🟡 Warnings: 40   🔵 Info: 0
- 38 of 92 deployments have at least one finding. Lifecycle **per the cronograma**: 84 retrieved, 6 in the field, 2 scheduled but never installed. **Per ODK there are 15 in the field** — the cronograma is missing 9 late-July installations (see anomaly B).
- **Priority actions this month:**
  1. **Add the 9 July 20–27 installations to the cronograma** (CCN-011, CCN-015, GIZ-003, GIZ-015, NAC-010, NAC-013, POT-015, PRI-012, SEC-011). They are currently invisible to overdue-retrieval monitoring; their retrievals come due ~Aug 19–26. The 6 registered ones also come due this week (Aug 11–16): NAC-014, GIZ-006, CCN-002, POT-007, PRI-010, SEC-002.
  2. **Fix the ODK record for NAC-009 and POT-005.** The cronograma shows them "never installed" (54/45 days overdue), but ODK has `retrieve_sensors` submissions from Jul 17 and Jul 27 with truncated IDs (`NAC-009_V`, `POT-005_V`), and POT-005's iButton is already in Drive: they were installed without an install form and **have already been retrieved**. Correct the IDs / backfill the install, and upload their data.
  3. **Upload cameras + audio for 6 retrieved sites that only have iButton data**: NAC-001, GIZ-001, CCN-006, REF-012, PRI-007, SEC-004. The Drive folders exist and are empty; the cards/recorders are back from the field.
  4. **Empty the FCAT-BIOCHOCO Shared Drive trash** (28,403 items left over from July's blank-photo cleanup). Trash counts toward Google's 500K cap: the drive sits at **85.2%** and fires a critical email alert **every day**. Emptying it drops the drive to ~79.5%.
  5. **Remove the duplicate audio in NAC-012** — 63 recordings uploaded to Drive twice (same name and size, two file IDs). BirdNET counted them double.

## Comparison with June 2026
- **New: ~19 · Persistent: ~23 · Resolved: ~19**
- Strong operational trend: **all 4 overdue retrievals** were resolved (incl. POT-008), **both retrieved-with-no-data sites** now have full data (PRI-003, NAC-007), REF-003's camera-clock issue is gone (its 180 out-of-window images disappeared), and **the entire verification queue was cleared** (11 deployments in June → 0 today; the team verified everything in July — 941 detections deleted, 51 bulk blank-photo cleanups).
- What persists is concentrated in **low iButton coverage** (the same 10 sites as June, unchanged — pointing to mission configuration, not individual failures) and historical failed-ML-job warnings.
- The big new items: the cronograma↔ODK drift (9 active installations missing from the sheet; NAC-009/POT-005 retrieved under truncated IDs) and the block of 6 sites awaiting upload.

## 1. Overdue retrieval
No findings **among cronograma deployments**. ✅ June's four (POT-008, GIZ-013, CCN-007, REF-013) were all retrieved. Next due dates: Aug 11–16 (the 6 registered sites) and ~Aug 19–26 (the 9 July installations missing from the cronograma — see anomaly B).

## 2. Overdue installation
| Deployment | Planned install | Days overdue | Severity |
|---|---|---|---|
| NAC-009_V1 | 2026-06-17 | **54** | 🔴 |
| POT-005_V1 | 2026-06-26 | **45** | 🔴 |

> **Important nuance (ODK audit):** the formal finding is correct — no `instalar_sensores` submission exists — but ODK does have `retrieve_sensors` submissions from Jul 17 (`NAC-009_V`) and Jul 27 (`POT-005_V`) with the deployment ID **truncated** (missing the visit digit), and POT-005's iButton file is already in Drive. In other words: the sensors **were installed and have already been retrieved**, but the install form was never submitted and the retrieve form carried a malformed ID (probably typed by hand because the picker couldn't find the deployment). **Action:** correct the two submissions in ODK Central (or backfill the install), and upload NAC-009's data.

## 3. Retrieved with no data
No findings. ✅ PRI-003 and NAC-007 (red in June) now have complete data in Drive.

## 4. Partial upload
| Deployment | Present | Missing | Counts (cam / audio / iBtn) | State |
|---|---|---|---|---|
| NAC-001_V1 | iButton | cameras, audio | 0 / 0 / 1 | **new** |
| GIZ-001_V1 | iButton | cameras, audio | 0 / 0 / 1 | **new** |
| CCN-006_V1 | iButton | cameras, audio | 0 / 0 / 1 | **new** |
| REF-012_V1 | iButton | cameras, audio | 0 / 0 / 1 | **new** |
| PRI-007_V1 | iButton | cameras, audio | 0 / 0 / 1 | **new** |
| SEC-004_V1 | iButton | cameras, audio | 0 / 0 / 1 | **new** |
| POT-011_V1 | audio, iButton | cameras | 0 / 5451 / 1 | persistent |
| POT-009_V1 | cameras, iButton | audio | 405 / 0 / 1 | persistent (field note) |
| CCN-004_V1 | cameras, audio | iButton | 30 / 5578 / 0 | persistent |
| CCN-005_V1 | audio, iButton | cameras | 0 / 5146 / 1 | explained (field note) |
| POT-014_V1 | audio, iButton | cameras | 0 / 4462 / 1 | explained (field note) |

> **Recommended action:** the 6 "iButton-only" sites are this month's main upload queue — confirm the cards and recorders are at the office and upload them. POT-011 still has no explanation for its missing cameras (check whether the camera captured nothing, like CCN-005/POT-014, or the photos weren't uploaded). CCN-004: verify whether the iButton was retrieved.

## 5. Missing coordinates
NAC-009_V1 and POT-005_V1 (🟡) — the same two never-installed deployments; no ODK submission means no coordinates. Resolves together with item 2.

## 6. Unverifiable counts (Drive errors)
No findings: the live re-count completed without errors across all 92 deployments. ✅

## 7. Files outside the deployment window
| Deployment | Window | Images outside | State |
|---|---|---|---|
| REF-001_V1 | 2026-03-11 → 2026-03-23 | 2 | new (trivial) |
| POT-010_V1 | 2026-04-18 → 2026-05-18 | 2 | persistent (trivial) |

> REF-003 (180 in June) no longer appears — resolved. The 2-photo cases are typical install/retrieval test shots.

## 8. Processing health (iButton / ML)

### Low iButton coverage — the same 10 sites as June, unchanged
GIZ-012 (38%), CCN-013 (57%), SEC-014 (67%), POT-003 (75%), NAC-012 (76%), GIZ-010 (76%), NAC-011 (77%), CCN-008 (78%), PRI-006 (89%), SEC-003 (90%).

> **Recommended action:** two months with zero change confirms these aren't individual failures: the 75–78% block (5 sites) points to a **mission configuration** difference. Review the iButton launch protocol before next season.

### Failed ML jobs
12 deployments carry historical failed-job warnings. July's **new** failures already self-recovered: 4 from insufficient disk (Jul 11 — the disk guard worked and failed cleanly) and 2 from model-server crashes (Jul 13 and 21); POT-002, POT-004, NAC-004 and POT-008 were successfully reprocessed Jul 13–23 and are **verified**.

> **Known false positive:** "POT-001: 738 failed images" comes from a completed **compression** job (Jul 24) that recorded `failed_images = total`; all 738 images are processed and fine. A minor accounting bug in the compression job, not a data problem.

### Verification queue: empty ✅
June had 11 processed-but-unverified deployments; today **0** — the entire current project is verified.

## Additional anomalies (extended audit beyond the 8 checks)

Read-only queries against the production database (referential integrity, duplicates, audio windows, audio pipeline, shared drives, system events).

### A. July's blank-photo cleanup left the Drive "full" and alerting daily 🔴→easy fix
Between Jul 6–30 the team deleted confirmed-blank photos through the portal (51 bulk actions; the Drive camera count dropped 37,723 → 15,908, consistent across DB and Drive — **no data loss**). But deleted files go to the **trash**, which still counts toward the 500K cap: FCAT-BIOCHOCO sits at **85.2%** with 28,403 trashed items, is read-only, and has emailed a critical alert **every day** since Aug 7. **Emptying the trash** (or waiting for the 30-day auto-purge, ~Aug 27–29) returns it to ~79.5% and silences the alerts. FCAT-BIOCHOCO-4 (14.8%) is absorbing new uploads fine.

### B. The cronograma is missing 9 active installations — ODK shows 15 sensors in the field, this review only saw 6 🔴
The portal map (which reads live ODK) shows 15 sites with an installed sensor; this review, which iterates the **cronograma**, only saw 6. The 9 missing ones were installed **July 20–27** and never added to the sheet: CCN-011, CCN-015, GIZ-003, GIZ-015, NAC-010, NAC-013, POT-015, PRI-012, SEC-011. Until they're in the cronograma, **no overdue-retrieval check watches them** — their retrievals come due ~Aug 19–26. There is also one junk ODK submission (`deployment_id` = `_V1`, May 18) and 2 duplicate install submissions worth cleaning up.

### C. 63 duplicated audio recordings in NAC-012_V1 (+1 in REF-001) 🟡
The complete 5-minute series from Mar 22, 11:45–16:55 (63 WAV files, ~5.8 MB each) exists **twice** in Drive (same name and size, different file IDs — double upload ~May 13). BirdNET processed both copies, so those hours are **double-counted** in the detections feeding occupancy and validation. REF-001_V1 also has one minor duplicate (`2MM20921_20260311_085000.wav`, 0.1 MB, truncated). Action: delete one copy of each in Drive and re-sync; consider cleaning the duplicated detections.

### D. 5 deployment rows with no Drive folder (2 are real sensors in the field) 🟡
POT-015_V1 (Jun 22) and NAC-013_V1/V2/V3 + NAC-014_V1 (Jul 11) exist in the DB with no Drive folder. In light of finding B, **POT-015_V1 and NAC-013_V1 are not junk rows: they are real sensors installed Jul 27 and Jul 20** whose rows were pre-created; they're missing their Drive folder and cronograma entry. The duplicate NAC-014_V1 row (id 513; the real one is scanned and in the field) and NAC-013_V2/V3 do look like leftovers. Action: create folders + cronograma entries for POT-015/NAC-013 and delete the 3 leftover rows.

### E. SEC-013_V1: 19 new images unprocessed 🟡
19 images stuck in "pending" with no ML job queued (its last job was audio, Aug 1). Action: run an incremental ML job.

### F. Audio modification dates are upload dates, not recording dates 🔵
In ~15 deployments, all audio has Drive `modifiedTime` = upload day (e.g. CCN-003: 6,142 files "May 19–21"), typical of Drive web-UI uploads that don't preserve mtime. **Do not build audio window QC on mtime**; the filename timestamp (`2MM20619_20260322_114500.wav`) is authoritative. (The standard review already defers audio window QC — this confirms it should stay that way.)

### G. Legacy project hygiene (informational) 🔵
- **92,162 historical images** (TP-xxx and PUCE projects) have **no timestamp at all** (no EXIF, no `file_modified`) — blocking temporal/occupancy analyses of the historical data; a backfill from Drive `modifiedTime` could recover part of it.
- 10 duplicated legacy deployment pairs (PUCE project) pointing at **two distinct same-named Drive folders** (e.g. `1_F_B`); nearly all with 0 images.
- 4,281 legacy videos pending frame extraction + 63 failed.
- 23,155 unverified camera identifications — almost all historical (the current project is fully caught up).

### H. Audio pipeline state 🔵
- **BirdNET coverage complete**: all 77 deployments with audio have detections (2,784,389 detection/identification pairs, perfect 1:1, no orphans). Acoustic indices nearly complete (minor gaps, max 50 files at GIZ-010).
- **FLAC compression at 16.6%** (62,357 of 375,025; 312,668 WAV remain, ~30 GB per large deployment). No non-revertible files, no format inconsistencies.
- 27 retrieved sites have their iButton file in Drive **not yet imported into the portal** (56 imported). Importing them feeds thermal coverage.
- The BirdNET threshold-validation module is not yet deployed to production (the 2.78M identifications remain "unverified" awaiting that workflow).

### Checks that came back clean ✅
No referential-integrity orphans, no cross-deployment duplicate Drive IDs, no corrupt timestamps (future/pre-2000) outside the historical projects, iButton rows = imported rows in all 56 cases, no stuck jobs, weekly occupancy runs healthy (741 models on Aug 9), and daily drive reconciliation error-free (trash aside).

## Findings explained by field notes
- **CCN-005_V1** — no cameras: _"had no photos, was 0/0"_ (already recorded in June).
- **POT-014_V1** — no cameras: _"the camera did not record any photos, we don't know what could…"_ — camera failure in the field, not an upload failure.
- **POT-009_V1** — no audio: _"site POT-009-V001 did not record audio data…"_ — recorder failure in the field.

## Appendix — methodology and sources
- **Sources:** cronograma (Google Sheets), ODK (`instalar_sensores`/`retrieve_sensors`), live Drive re-count (92/92, 0 errors), production database (read-only queries), system events.
- **Thresholds:** overdue >14 days = error; iButton coverage <95% = low.
- **Standard snapshot:** `data/reviews/snapshot-2026-08.json` · **Extended queries:** `data/reviews/audit-adhoc-2026-08.json`, `audit-adhoc2-2026-08.json`, `audit-adhoc3-2026-08.json`.
- The extended audit covered: referential integrity, duplicates (files and rows), audio/iButton windows, compression/BirdNET/indices state, Shared Drive capacity, warn/error system events since July, and the daily upload-count series.
