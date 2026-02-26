---
module: BioChoco
date: 2026-02-24
problem_type: integration_issue
component: service_object
symptoms:
  - "Retrieve date column shows empty or wrong date for all deployments"
  - "deriveSyncUpdates() writes empty retrieve dates to Google Sheet"
  - "fecha_recuperacion field returns undefined from ODK submissions"
root_cause: wrong_api
resolution_type: code_fix
severity: medium
tags: [odk-central, biochoco, form-migration, field-rename, retrieve-date]
---

# Troubleshooting: ODK retrieve_sensors Form Restructured — fecha_recuperacion Moved to retrieval_info.retrieval_date

## Problem

The retrieve date for BioChoco deployments was being extracted from the wrong location in ODK `retrieve_sensors` submission JSON. The form was restructured — the date field moved from `site_selection.fecha_recuperacion` to a new `retrieval_info` group as `retrieval_date`. This is the exact same pattern as the deploy date restructuring documented in [odk-form-field-restructuring-deploy-date.md](./odk-form-field-restructuring-deploy-date.md).

## Environment
- Module: BioChoco (tools, data, camera-trap)
- Affected Component: Server actions that parse ODK retrieve submissions
- Date: 2026-02-24

## Symptoms
- Retrieve date appears empty or null in the data status table
- `deriveSyncUpdates()` in tools/actions.ts writes empty retrieve dates to the Google Sheet
- No error thrown — the old field path simply doesn't exist in new submissions
- Same deployment shows correct `deployment_id` and `site_id` (from `site_selection` group) but missing date

## What Didn't Work

**Direct solution:** The problem was predicted by the deploy date solution doc (see Prevention section) and identified immediately by inspecting ODK submission structure.

## Solution

Updated all consumers of retrieve submission data to check `retrieval_info.retrieval_date` first, falling back to old paths for legacy submissions:

**Code changes:**

```typescript
// Before (broken):
const sel = sub.site_selection as Record<string, unknown> | undefined;
const date = (sel?.fecha_recuperacion as string) ?? (sub.fecha_recuperacion as string) ?? "";

// After (fixed):
const sel = sub.site_selection as Record<string, unknown> | undefined;
const retInfo = sub.retrieval_info as Record<string, unknown> | undefined;
const date = (retInfo?.retrieval_date as string) ?? (sel?.fecha_recuperacion as string) ?? (sub.fecha_recuperacion as string) ?? "";
```

### Old form structure
```
site_selection/
  deployment_id
  site_id
  fecha_recuperacion   ← date was here
```

### New form structure
```
site_selection/
  deployment_id
  site_id
retrieval_info/          ← new group
  retrieval_date         ← date is now here
```

## Files Changed

- `src/app/biochoco/tools/actions.ts` — `deriveSyncUpdates()` retrieve date extraction
- `src/app/biochoco/data/actions.ts` — `fetchSchedule()` retrieve date map building
- `src/app/biochoco/data/drive-folder-actions.ts` — retrieve date extraction for folder panel

## Why This Works

1. **Root cause:** The `retrieve_sensors` ODK XLSForm was restructured. The retrieval date moved from a flat field inside `site_selection` to a new `retrieval_info` group, matching the earlier `instalar_sensores` form restructuring.

2. The fallback chain (`retInfo?.retrieval_date ?? sel?.fecha_recuperacion ?? sub.fecha_recuperacion`) ensures both new and legacy submissions are handled correctly.

3. This is now the second time this exact pattern has occurred (deploy form in Feb 13, retrieve form in Feb 24), confirming that **all ODK form field moves need portal-wide code updates**.

## Prevention

- **When ANY ODK form is restructured**: search the entire portal codebase for the old field name. Multiple files consume the same submission data.
- **Fallback chain pattern**: Always chain `??` through old field locations when updating to maintain backward compatibility with older submissions.
- **Three consumers pattern**: BioChoco date extraction currently exists in 3 separate files (tools/actions.ts, data/actions.ts, data/drive-folder-actions.ts). Consider centralizing into a shared utility.
- **Log raw submission keys**: When a column shows correct IDs but null dates, log `Object.keys(sub.retrieval_info)` to find where the field moved.

## Related Issues

- See also: [ODK deploy date restructuring](./odk-form-field-restructuring-deploy-date.md) — identical pattern for `instalar_sensores` form
- See also: [ODK nested JSON flattening](./odk-nested-json-flattening.md) — related issue with ODK form group nesting
