---
title: ODK Central nested JSON groups not flattened for form submissions
category: integration-issues
tags: [odk-central, odata, json-normalize, cacao-monitoring, giz]
module: giz/cacao-monitoring
symptoms:
  - Cacao monitoring page renders but all values are 0, empty, or null
  - Record count is correct but field values are undefined
  - Other forms (e.g., tree planting) work fine
root_cause: ODK OData API returns grouped form fields as nested JSON objects; portal expected flat keys
severity: high
date_solved: 2025-02-09
---

# ODK Central Nested JSON Groups Not Flattened

## Problem

The "Monitoreo de Sobrevivencia de Cacao" page rendered correctly (correct record count, layout intact) but showed **no meaningful data** — all metrics were 0, map had no markers, table rows were empty. The Streamlit version of the same dashboard worked fine.

## Symptoms

- Page loads without errors
- `totalFarms` count is correct (records exist)
- All field values (`farmCode`, `plantsPlanted`, `survivalRate`, etc.) are `undefined`/`null`/`0`
- Tree planting dashboard (same ODK project) works correctly

## Root Cause

**ODK Central's OData API returns nested JSON for form fields inside groups.**

The cacao form (`monitoreo_cacao_v1`) uses XLSForm groups: `identificacion`, `metadata`, `datos_plantas`, `manejo`, `observaciones`. The API response looks like:

```json
{
  "__id": "abc",
  "identificacion": { "codigo_finca": "F001", "nombre_propietario": "Juan" },
  "datos_plantas": { "num_plantas_sembradas": 100, "num_plantas_vivas": 85 },
  "num_plantas_muertas": 15
}
```

The portal TypeScript code expected flat keys like `s.identificacion_codigo_finca`, but since the response is nested, all grouped fields resolved to `undefined`.

The **tree planting form** (`siembra_arboles`) worked because its fields are all at the root level — no groups — so the OData API returned them flat.

The **Streamlit version** handled this with `pd.json_normalize(data, sep="_")` which flattens nested objects into underscore-separated keys.

### Secondary issue: string-typed numbers

ODK OData sometimes returns numeric values as strings (e.g., `"85.5"` instead of `85.5`). After flattening, calling `Number.toFixed()` on a string value caused a runtime error in the survival rate badge component.

## Solution

### 1. Added `flattenObject()` utility to `src/lib/odk-client.ts`

Recursively flattens nested objects using `_` separator, matching `pd.json_normalize(data, sep="_")`. Skips system keys starting with `__` (except `__id`).

```typescript
function flattenObject(
  obj: Record<string, unknown>,
  prefix = "",
  sep = "_"
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}${sep}${key}` : key;
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !key.startsWith("__")
    ) {
      Object.assign(result, flattenObject(value as Record<string, unknown>, newKey, sep));
    } else {
      result[newKey] = value;
    }
  }
  return result;
}
```

### 2. Added `flatten` option to `fetchSubmissions()`

```typescript
export async function fetchSubmissions<T>(
  projectId: string,
  formId: string,
  options?: { since?: string; revalidate?: number; flatten?: boolean }
): Promise<T[]> {
  // ... existing pagination code ...
  const rawValues = data.value ?? [];
  const values = (options?.flatten
    ? rawValues.map((v: Record<string, unknown>) => flattenObject(v))
    : rawValues) as T[];
  // ...
}
```

### 3. Passed `flatten: true` for cacao monitoring

```typescript
const raw = await fetchSubmissions<OdkCacaoSubmission>(
  GIZ_PROJECT_ID, GIZ_FORM_CACAO_MONITORING,
  { flatten: true }
);
```

### 4. Added `toNum()` coercion for numeric fields

```typescript
function toNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}
```

Applied to all numeric fields in `transformSubmissions()` to handle ODK returning numbers as strings.

## Files Changed

- `src/lib/odk-client.ts` — `flattenObject()`, `flatten` option on `fetchSubmissions()`
- `src/app/giz/cacao-monitoring/actions.ts` — `toNum()` helper, `{ flatten: true }` option

## Prevention

- **When adding a new ODK form with groups**: always pass `{ flatten: true }` to `fetchSubmissions()`. Check the XLSForm — if it has `begin_group`/`end_group`, the OData response will be nested.
- **When mapping ODK fields to TypeScript types**: use a `toNum()` helper for numeric fields — ODK OData does not guarantee numeric types.
- **Quick diagnostic**: If a page shows the correct record count but empty field values, check whether the form uses groups and whether flattening is enabled.

## Key Insight

Forms without groups (like `siembra_arboles`) return flat JSON naturally. Forms with groups (like `monitoreo_cacao_v1`) return nested JSON. The `flatten` option is opt-in to avoid breaking existing flat-form consumers.
