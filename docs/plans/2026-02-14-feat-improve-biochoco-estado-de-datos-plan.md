---
title: Improve BioChoco Estado de Datos table
type: feat
date: 2026-02-14
---

# Improve BioChoco Estado de Datos Table

## Overview

Redesign the "Estado de Datos" table at `/biochoco/data` to be more field-team friendly. The current table shows deployment upload status but lacks clear guidance on **where** to upload each data type and shows unnecessary columns. The goal is to make it obvious for field staff where and how to upload camera, audio, and iButton data to Google Drive.

## Problem Statement

Field team members viewing the Estado de Datos table face several UX issues:

1. **No direct links to upload locations** — the table shows file counts but doesn't tell users _where_ to upload data. There's only a single external link icon per row pointing to the parent folder.
2. **"Verificar Drive" button is unclear** — users don't understand what it does or when to use it.
3. **"Visita" column is unnecessary clutter** — adds visual noise without actionable value.
4. **Missing date context** — no "Fecha Instalación" or "Fecha Recuperación" columns, which are important for field coordination.

## Proposed Solution

### Column Changes

**Remove:**
- `Visita` column (visit number)

**Add:**
- `Fecha Instalación` — from `ScheduleRow.actualDeployDate` (may be null, show "—")
- `Fecha Recuperación` — from `ScheduleRow.actualRetrieveDate` (may be null, show "—")

**Final column order:**
`Instalación | Sitio | Estado | F. Instalación | F. Recuperación | Cámaras | Audio | iButton`

### Data Type Cells (Cámaras, Audio, iButton)

Each data type cell shows both:
- **File count** (after verification): e.g. "5 archivos" with a check icon, or "0" with an X icon
- **"Subir" button/link** that opens the specific Google Drive subfolder (`camaras_trampas`, `grabadores_de_audio`, or `ibutton`) directly

Before verification runs, show a generic "Subir" link to the parent deployment folder. After verification completes, links point to the specific subfolder.

**Cell layout example (after verification):**
```
✓ 5  [Subir ↗]
```
```
✗ 0  [Subir ↗]
```

### "Verificar Drive" Button Improvements

Rename and add explanation:

- **New button label:** "Actualizar Conteo" (or keep "Verificar Drive" with a tooltip)
- **Add helper text** below the search bar or as a tooltip: "Consulta Google Drive para contar cuántos archivos se han subido en cada carpeta. Ejecutar después de subir nuevos datos."

### Remove Standalone External Link Column

The last column with a single `ExternalLink` icon per row becomes redundant since each data type cell now links directly to its subfolder. Remove it.

## Technical Approach

### 1. Modify `UploadStatus` type and `checkDeploymentUploads()` — `src/lib/drive-client.ts`

The `checkDeploymentUploads` function already lists subfolders in step 1 (to get subfolder names → IDs). Extend `UploadStatus` to also return subfolder IDs so the client can construct direct links.

```typescript
export interface UploadStatus {
  camarasTrampas: number | null;
  grabadoresDeAudio: number | null;
  ibutton: number | null;
  subfolderIds: {
    camarasTrampas: string | null;
    grabadoresDeAudio: string | null;
    ibutton: string | null;
  };
}
```

In `checkDeploymentUploads`, populate `subfolderIds` from the existing `subfolderMap` that's already built in step 1. Minimal change — just capture the IDs that are already being looked up.

### 2. Update the table component — `src/app/biochoco/data/upload-status-table.tsx`

- **Remove** the `Visita` column (`visitNumber`) and its `SortButton`
- **Remove** the `visitNumber` from `SortField` type
- **Add** two date columns: "F. Instalación" and "F. Recuperación"
  - Display `actualDeployDate` and `actualRetrieveDate` from `ScheduleRow`
  - Format as short date (e.g. "15 ene 2026") or show "—" if null
- **Redesign** the Cámaras/Audio/iButton cells:
  - Before verification: show a "Subir" button linking to the parent deployment folder
  - After verification: show file count icon + "Subir" button linking to the specific subfolder
  - The "Subir" button is a small outline button or styled link with an upload/external icon
- **Remove** the last `ExternalLink` column (now redundant)
- **Rename** "Verificar Drive" button and add explanation text
- **Add** helper text under the page subtitle explaining what the table shows and what "Subir" means

### 3. Update `DriveStatusResult` and actions — `src/app/biochoco/data/actions.ts`

The `DriveStatusResult` interface passes through `UploadStatus` from `drive-client.ts` via the `uploads` field. No structural change needed — the new `subfolderIds` will flow through automatically.

### 4. No schema or type changes needed for `ScheduleRow`

`ScheduleRow` already has `actualDeployDate` and `actualRetrieveDate` fields. They're populated from the Google Sheets schedule. No changes needed.

## Acceptance Criteria

- [ ] `Visita` column is removed from the table
- [ ] `Fecha Instalación` column shows `actualDeployDate` (or "—" if null)
- [ ] `Fecha Recuperación` column shows `actualRetrieveDate` (or "—" if null)
- [ ] Each data type cell (Cámaras, Audio, iButton) has a "Subir" link/button
- [ ] After verification, "Subir" links point to the specific Drive subfolder (not just parent)
- [ ] Before verification, "Subir" links point to the parent deployment folder
- [ ] "Verificar Drive" button has clearer labeling/explanation for field team
- [ ] The standalone external link column (last column) is removed
- [ ] Table still auto-checks visible rows on page load
- [ ] Table works correctly with sidebar open (no horizontal overflow — per learnings)

## Files to Modify

| File | Change |
|------|--------|
| `src/lib/drive-client.ts` | Add `subfolderIds` to `UploadStatus`, populate in `checkDeploymentUploads` |
| `src/app/biochoco/data/upload-status-table.tsx` | Column changes, cell redesign, button rename, helper text |
| `src/app/biochoco/data/actions.ts` | No structural change (types flow through), but verify `DriveStatusResult` still works |

## References

- Current table component: `src/app/biochoco/data/upload-status-table.tsx`
- Drive client: `src/lib/drive-client.ts:78-169` (`checkDeploymentUploads`)
- Schedule types: `src/lib/schedule-types.ts` (already has date fields)
- Learnings: horizontal overflow fix requires `min-w-0` on flex children (see `docs/solutions/ui-bugs/biochoco-overview-horizontal-scroll-map-overlap.md`)
- Learnings: ODK deploy date field moved — use fallback chaining (see `docs/solutions/integration-issues/odk-form-field-restructuring-deploy-date.md`)
