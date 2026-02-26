---
title: ODK instalar_sensores form restructured — fecha_instalacion moved to deployment_info.deploy_date
category: integration-issues
tags: [odk-central, biochoco, camera-trap, form-migration, field-rename]
module: biochoco/data, camera-trap
symptoms:
  - Fecha column shows "—" for all rows in Crear Carpetas panel
  - dateInstalled is null for all ODK deploy submissions
  - Sync ODK tool writes empty dates to schedule
root_cause: ODK form instalar_sensores was restructured — date field moved from site_selection.fecha_instalacion to deployment_info.deploy_date
severity: medium
date_solved: 2026-02-13
---

# ODK Form Field Restructuring — Deploy Date Moved

## Problem

The "Crear Carpetas de Drive" panel on `/biochoco/data` showed all 11 missing deployments with "—" in the Fecha column. The date was being extracted from the wrong location in the ODK submission JSON.

## Symptoms

- All rows in Crear Carpetas table show "—" for Fecha
- `dateInstalled` is `null` for every parsed submission
- `deployment_id` and `site_id` extract correctly from the same `site_selection` group
- No errors thrown — the field simply doesn't exist at the expected path

## Investigation

Added debug logging to `getMissingDriveFolders()` to inspect the raw ODK submission structure:

```typescript
console.log("[DEBUG] site_selection keys:", Object.keys(sel));
// → ['site_selection_method', 'site_map', 'site_search', 'site',
//    'site_id', 'site_name', 'habitat_type', 'landowner_name',
//    'current_visit_number', 'next_visit_number', 'deployment_id',
//    'visit_number_to_save', 'site_info_note']
// No fecha_instalacion!

console.log("[DEBUG] deployment_info keys:", Object.keys(depInfo));
// → ['deploy_date', 'deploy_time']

console.log("[DEBUG] deployment_info value:", depInfo);
// → { "deploy_date": "2026-02-13", "deploy_time": "09:30:00.000-05:00" }
```

The date moved from `site_selection.fecha_instalacion` to `deployment_info.deploy_date` when the ODK XLSForm was restructured.

## Root Cause

The `instalar_sensores` ODK form was restructured. The installation date field was moved from the `site_selection` group (as `fecha_instalacion`) to a new `deployment_info` group (as `deploy_date`). The portal code was still looking in the old location.

### Old structure
```
site_selection/
  deployment_id
  site_id
  fecha_instalacion   ← date was here
```

### New structure
```
site_selection/
  deployment_id
  site_id
deployment_info/      ← new group
  deploy_date         ← date is now here
  deploy_time
```

## Solution

Updated all 3 files that extract dates from deploy submissions to check `deployment_info.deploy_date` first, falling back to old paths for any legacy submissions:

```typescript
const depInfo = sub.deployment_info as Record<string, unknown> | undefined;
const dateInstalled =
  (depInfo?.deploy_date as string) ??      // new location
  (sel?.fecha_instalacion as string) ??     // old: inside site_selection
  (sub.fecha_instalacion as string) ??      // old: top-level
  null;
```

## Files Changed

- `src/app/biochoco/data/drive-folder-actions.ts` — `parseDeploySubmissions()` (Crear Carpetas panel)
- `src/app/biochoco/tools/actions.ts` — `deriveSyncUpdates()` deploy date extraction
- `src/app/camera-trap/odk-actions.ts` — camera trap ODK sync deploy date extraction

## Prevention

- **When ODK forms are restructured**: check all portal code that reads from that form. Search for the old field name across the codebase.
- **Diagnostic pattern**: If a column shows correct IDs but null dates, log the raw submission keys for each group to find where the field moved.
- **Fallback pattern**: Always chain `??` through old field locations when updating, so legacy submissions still parse correctly.
- **Watch for retrieve form**: The `retrieve_sensors` form may also be restructured. `fecha_recuperacion` may move to a similar `retrieval_info.retrieve_date` group. Currently only used in `biochoco/tools/actions.ts` sync tool.

## Related

- See also: [ODK retrieve date restructuring](./odk-retrieve-date-field-restructured-20260224.md) — same pattern, retrieve_sensors form (Feb 24, 2026)
- See also: [ODK Central nested JSON groups not flattened](./odk-nested-json-flattening.md) — related issue with ODK form group nesting
