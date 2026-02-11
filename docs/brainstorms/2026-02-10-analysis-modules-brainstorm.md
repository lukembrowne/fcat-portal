# Brainstorm: Modular Analysis Modules + Project Data Hub

**Date:** 2026-02-10
**Status:** Draft

## What We're Building

A modular architecture where **analysis pipelines** (camera traps, audio, temperature) are independent top-level modules in the portal, while **projects** (BioChoco, others) have a data status view that aggregates upload and analysis progress across all data types per deployment.

### The Problem

BioChoco deployments produce three data types from each site visit: camera trap images, passive audio recordings (songmeters), and iButton temperature data. Currently:

- Camera trap processing lives under BioChoco in the nav but has its own SQLite tables and permissions — it's already semi-independent
- There's no visibility into whether data has been uploaded to Google Drive after field retrieval
- There's no way to track analysis progress across data types per deployment
- Other FCAT projects also use camera traps but can't easily reuse the pipeline

### Users

Primary user is the **field coordinator** who needs to:
1. See at a glance which deployments have data uploaded to Drive (per data type)
2. Track which data has been processed/analyzed

## Why This Approach

**Approach chosen: Modular Analysis Modules + Project Hub**

Analysis modules are standalone tools that can be used by any project. Each project gets a data status page that aggregates information from the relevant analysis modules and Google Drive.

Rejected alternatives:
- **Embedded in BioChoco** — simpler but camera traps wouldn't be reusable for other projects that actively need them
- **Central data registry** — over-engineered abstraction before we know all use cases

## Key Decisions

### 1. Navigation: Top-level "Analisis" section

Analysis modules move out from under BioChoco into their own top-level nav group:

```
Proyectos
  Inicio
  GIZ
    ...
  BioChoco
    Resumen (/biochoco/overview)
    Estado de Datos (/biochoco/data)     <-- NEW
    Herramientas (/biochoco/tools)

Analisis                                  <-- NEW top-level section
  Camaras Trampa (/camera-trap)
  Audio (/audio)                          <-- future
  Temperatura (/temperature)              <-- future
```

Each analysis module has its own project-level permission (e.g., `"camera-trap"`, `"audio"`, `"temperature"`).

### 2. Linking: ODK deployment_id as the common key

The ODK Central deployment_id (e.g., `CCN-001_V1`) is the canonical identifier. It appears in:
- ODK Central (source of truth)
- Google Sheets (schedule)
- Google Drive folder names (`BIOCHOCO_Data/{deployment_id}/`)
- Analysis module records in SQLite (optional `externalDeploymentId` field)

Camera trap deployments in SQLite gain an optional `externalDeploymentId` field so they can be linked back to BioChoco (or any project) deployments without tight coupling.

### 3. Upload tracking via Google Drive API

The portal checks the Google Drive API to determine upload status per data type. The Drive folder structure is:

```
FCAT-BIOCHOCO/BIOCHOCO_Data/
  {deployment_id}/
    camaras_trampas/      <-- camera trap images
    grabadores_de_audio/  <-- audio recordings
    ibutton/              <-- temperature data
```

Upload status = "are there files in the subfolder?" via Drive API. Need to investigate whether the existing Sheets service account has Drive API access or needs additional scopes.

### 4. BioChoco data status page (`/biochoco/data`)

New page under BioChoco showing a table of deployments with columns for:
- Deployment ID, site, visit number
- Upload status per data type (icons/badges: uploaded / not uploaded / partial)
- Analysis status per data type (e.g., camera traps: unprocessed / ML processed / annotated / verified)
- Links to the relevant analysis module for each data type

### 5. Camera trap pipeline stays largely as-is

The existing camera trap code at `/camera-trap/` doesn't need major refactoring — it just moves in the nav hierarchy and gains the `externalDeploymentId` field for linking. Routes stay the same.

### 6. Future analysis modules follow the same pattern

Audio (BirdNET-based ML pipeline) and temperature (basic summaries: min/max/mean, time series charts) will follow the same modular pattern when built. Each gets its own route group, DB tables, and permissions.

## Data Type Summary

| Data Type | Upload Check | Processing Pipeline | Status |
|---|---|---|---|
| Camera traps | Drive: `camaras_trampas/` | ML detection + classification + human annotation | Exists today |
| Audio | Drive: `grabadores_de_audio/` | BirdNET or similar ML species ID | Future build |
| Temperature | Drive: `ibutton/` | Basic CSV parsing + summary stats | Future build |

## Open Questions

1. **Drive API access**: Does the existing Google service account have Drive API scope? Need to check credentials and folder sharing.
2. **Drive folder ID**: How do we resolve deployment_id to a Drive folder? Do we need a parent folder ID and search by name, or is there a mapping somewhere?
3. **Permissions model**: Should BioChoco `editor` role automatically grant read access to analysis modules, or keep permissions fully independent?
4. **Caching**: Drive API calls could be slow if checking many deployments. Should we cache upload status in SQLite with a refresh button, or check live each time?
5. **Other projects**: When another project needs camera traps, how do they register their deployments? Same pattern (Sheets + Drive) or different?

## Implementation Priority

1. **Phase 1**: Move camera traps to top-level "Analisis" nav section. Add `externalDeploymentId` to deployments table.
2. **Phase 2**: Build `/biochoco/data` page with upload status from Google Drive API.
3. **Phase 3**: Connect camera trap analysis status to the BioChoco data page.
4. **Phase 4**: Audio analysis module (when ready).
5. **Phase 5**: Temperature analysis module (when ready).
