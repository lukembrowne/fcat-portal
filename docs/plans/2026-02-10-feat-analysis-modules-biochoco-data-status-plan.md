---
title: "feat: Add top-level Análisis nav section and BioChoco data upload status page"
type: feat
date: 2026-02-10
brainstorm: docs/brainstorms/2026-02-10-analysis-modules-brainstorm.md
reviewed: true
---

# Add Top-level Análisis Nav Section + BioChoco Data Upload Status Page

## Overview

Move camera trap analysis out of the BioChoco nav tree into a new top-level "Análisis" section (preparing for future audio and temperature modules). Add a `/biochoco/data` page that checks Google Drive via API to show field coordinators which deployments have their data uploaded per data type (camera traps, audio, iButton).

## Problem Statement

Field coordinators have no visibility into whether data from retrieved deployments has been uploaded to Google Drive. They must manually check Drive folders for each deployment. Additionally, camera trap processing is nested under BioChoco in the nav, but other projects also use camera traps — it should be reusable.

## Proposed Solution

**Phase 1**: Restructure navigation to create a top-level "Análisis" section.

**Phase 2**: Build `/biochoco/data` page that loads the BioChoco schedule and checks Google Drive API for file presence in each deployment's data type subfolders.

## Key Assumptions

- **Upload status = file count**: `number | null` per subfolder. `null` = subfolder not found or check failed. `0` = subfolder exists but empty. `> 0` = data uploaded.
- **`driveFolderLink` points to deployment folder**: e.g., `https://drive.google.com/drive/folders/{id_of_CCN-001_V1}`, with `camaras_trampas/`, `grabadores_de_audio/`, `ibutton/` as children.
- **Use Sheets `status` column** to determine "retrieved" deployments (not ODK-derived status). Note in UI that running "Sync ODK" keeps this accurate.
- **No caching initially**: Fetch Drive status server-side with `Promise.allSettled` and concurrency limit. Accept slower load. Add caching later if needed.
- **No shared auth module**: `drive-client.ts` gets its own copy of the 4-line `getServiceAccountKey()` helper. Extract if a third Google client ever appears.

## Technical Approach

### Phase 1: Navigation Restructuring

#### 1.1 Add new icon to the icon system

**`src/components/sidebar-nav.tsx`** — extend `IconName` union:
```ts
export type IconName = "home" | "tree-pine" | "leaf" | "camera" | "shield" | "dollar-sign" | "bar-chart-3";
```

**`src/components/sidebar-shell.tsx`** — add to `ICONS` map:
```ts
import { ..., BarChart3 } from "lucide-react";

const ICONS: Record<IconName, ...> = {
  ...existing,
  "bar-chart-3": BarChart3,
};
```

#### 1.2 Restructure sidebar navigation

**`src/components/sidebar-nav.tsx`** — modify the nav tree construction:

**Before:**
```
Proyectos
  BioChoco (shows if hasBiochoco || hasCameraTrap)
    Resumen
    Recursos
    Herramientas
    Camaras Trampa (sub-group, shows if hasCameraTrap)
      Dashboard
      Resultados
      Anotaciones
```

**After:**
```
Proyectos
  Inicio
  GIZ > ...
  BioChoco (shows if hasBiochoco)
    Resumen
    Recursos
    Datos                     ← NEW (Phase 2, viewer+)
    Herramientas              (editor+)

Análisis                       ← NEW section (bar-chart-3 icon)
  Cámaras Trampa (shows if hasCameraTrap)
    Dashboard (/camera-trap)
    Resultados (/camera-trap/results)
    Anotaciones (/camera-trap/annotate)

Administración > ...
```

Key changes:
- Remove camera trap children from `biochocoChildren`
- BioChoco section guard changes from `hasBiochoco || hasCameraTrap` → `hasBiochoco`
- Create new `NavSection` with `title: "Análisis"` containing camera trap items
- Camera trap permission check (`hasCameraTrap`) moves to the new section
- Add "Datos" to `biochocoChildren` (after Recursos, before Herramientas), visible to all `biochoco` viewers
- **Verify**: Check if any users have `camera-trap` but not `biochoco` permission — their nav experience changes (they'll see Análisis instead of BioChoco)

---

### Phase 2: Google Drive Client + BioChoco Data Page

#### 2.1 Create Google Drive client

**Create `src/lib/drive-client.ts`**:

```ts
import "server-only";
import { google, type drive_v3 } from "googleapis";

// Own copy of service account key helper (4 lines, not worth a shared module)
function getServiceAccountKey(): Record<string, string> { ... }

// Singleton Drive client
let driveClient: drive_v3.Drive | null = null;

function getDrive(): drive_v3.Drive {
  if (driveClient) return driveClient;
  const key = getServiceAccountKey();
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  driveClient = google.drive({ version: "v3", auth });
  return driveClient;
}

// Extract folder ID from Google Drive URL
// Handles: /drive/folders/{id}, /drive/folders/{id}?usp=sharing, /drive/u/0/folders/{id}
export function extractFolderId(driveUrl: string): string | null { ... }

// Check what data exists in a deployment folder
// Returns file counts per data type subfolder
export async function checkDeploymentUploads(
  folderId: string
): Promise<ActionResult<UploadStatus>> { ... }
```

Types (in `drive-client.ts`):
```ts
export interface UploadStatus {
  camarasTrampas: number | null;    // file count, null = subfolder not found or check failed
  grabadoresDeAudio: number | null;
  ibutton: number | null;
}
```

**Drive API calls** per deployment:
1. `drive.files.list` with `q: "'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder'"` to find the three subfolders
2. For each subfolder found, `drive.files.list` with `q: "'${subfolderId}' in parents"` with `pageSize: 1000` to get file count
3. Use `Promise.allSettled` to handle partial failures gracefully

**Unit test `extractFolderId`** — pure string parsing, ideal test candidate:
- `https://drive.google.com/drive/folders/abc123` → `"abc123"`
- `https://drive.google.com/drive/folders/abc123?usp=sharing` → `"abc123"`
- `https://drive.google.com/drive/u/0/folders/abc123` → `"abc123"`
- `""` → `null`
- `"not a url"` → `null`

#### 2.2 Create server action

**Create `src/app/biochoco/data/actions.ts`**:

```ts
"use server";

export async function fetchDataStatus(): Promise<ActionResult<DataStatusRow[]>> {
  await requirePermission("biochoco", "viewer");

  // 1. Load schedule from Sheets
  // 2. Filter to "retrieved" deployments
  // 3. For each with a driveFolderLink, call checkDeploymentUploads()
  //    with concurrency limit (pLimit(10) or manual batching)
  // 4. Return combined results
}
```

Page-specific type (in `actions.ts` or colocated `types.ts`):
```ts
interface DataStatusRow {
  deployment: ScheduleRow;              // reuse existing type, no field duplication
  uploads: UploadStatus | null;         // null = no Drive link
  error?: string;                       // per-deployment error message
}
```

**Concurrency control**: Use `Promise.allSettled` with batches of 10 concurrent requests, or use `p-limit` if already available. Google Drive API rate limit is ~1,000 queries per 100 seconds — 10 concurrent is safe.

#### 2.3 Create page and client component

**Create `src/app/biochoco/data/page.tsx`** (Server Component):
```ts
// requirePermission("biochoco", "viewer")
// Call fetchDataStatus()
// Render UploadStatusTable or error
```

**Create `src/app/biochoco/data/upload-status-table.tsx`** (Client Component):

Table with columns:
| Deployment | Sitio | Visita | Cámaras | Audio | iButton |
|---|---|---|---|---|---|
| CCN-001_V1 | CCN-001 | 1 | ✅ 247 | ✅ 89 | ❌ 0 |
| CCN-001_V2 | CCN-001 | 2 | ✅ 312 | ⚠️ | ❌ 0 |

Status indicators:
- ✅ (green) + file count = files present (`count > 0`)
- ❌ (red) + "0" = subfolder exists but empty, or subfolder missing (`count === 0`)
- ⚠️ (yellow) = check failed (`count === null` with error)
- ➖ (gray) = no Drive folder link on this deployment

Empty state: "No hay despliegues recuperados" when no retrieved deployments exist.

Each row's deployment ID links to the Drive folder (opens in new tab).

#### 2.4 GCP setup requirements (manual, not code)

Document but don't automate:
1. Enable Google Drive API in the `biochoco-dashboard` GCP project
2. Share `FCAT-BIOCHOCO/BIOCHOCO_Data/` folder with the service account email as Viewer
3. Verify with a test API call

## Acceptance Criteria

### Phase 1
- [x] Camera trap nav items appear under a new top-level "Análisis" section with `bar-chart-3` icon
- [x] Camera trap nav items no longer appear nested under BioChoco
- [x] BioChoco section only shows when user has `biochoco` permission (not `camera-trap`)
- [x] Users with only `camera-trap` permission see "Análisis" section but not "BioChoco"
- [x] All existing camera trap URLs (`/camera-trap/*`) continue to work unchanged

### Phase 2
- [x] `/biochoco/data` page loads and displays upload status table for retrieved deployments
- [x] Each deployment shows status for 3 data types: camaras_trampas, grabadores_de_audio, ibutton
- [x] Upload status correctly reflects Google Drive folder contents (file count per subfolder)
- [x] Deployments without `driveFolderLink` show "Sin carpeta" indicator
- [x] Partial Drive API failures show per-deployment error, not page-level error
- [x] Drive API calls are concurrency-limited (max ~10 concurrent)
- [x] "Datos" appears in BioChoco nav for all biochoco viewers
- [x] Permission: `requirePermission("biochoco", "viewer")` on page and action
- [x] `drive-client.ts` includes `import "server-only"`
- [x] `extractFolderId` has unit tests covering URL variants
- [x] `drive-client.ts` has its own `getServiceAccountKey()` (no shared auth module)

## Files to Create/Modify

### New files
- `src/lib/drive-client.ts` — Google Drive API client with `UploadStatus` type
- `src/app/biochoco/data/page.tsx` — server component page
- `src/app/biochoco/data/actions.ts` — server action with `DataStatusRow` type
- `src/app/biochoco/data/upload-status-table.tsx` — client component for the table

### Modified files
- `src/components/sidebar-nav.tsx` — restructure nav, add Análisis section, add Datos link
- `src/components/sidebar-shell.tsx` — add BarChart3 icon to ICONS map

### NOT modified (per review)
- `src/db/schema.ts` — `externalDeploymentId` deferred to Phase 3
- `scripts/push-schema.mjs` — no schema changes needed
- `src/lib/sheets-client.ts` — no shared auth extraction, stays untouched

## Dependencies & Prerequisites

- **Google Drive API enabled** in the `biochoco-dashboard` GCP project
- **Service account shared** on `FCAT-BIOCHOCO/BIOCHOCO_Data/` Drive folder as Viewer
- **Verify `driveFolderLink` format** — confirm it points to deployment-level folders (not parent)

## Open Questions for Implementation

1. Should we show "deployed" (not yet retrieved) deployments in the table with a "Pendiente" status, or only show retrieved ones?
2. Exact file count: should we count only certain file types (`.jpg`, `.wav`, `.csv`) or all files in each subfolder?

## References

- Brainstorm: `docs/brainstorms/2026-02-10-analysis-modules-brainstorm.md`
- Sidebar nav: `src/components/sidebar-nav.tsx`
- Sheets client (auth pattern): `src/lib/sheets-client.ts`
- Schedule types: `src/lib/schedule-types.ts`
- BioChoco overview (page pattern): `src/app/biochoco/overview/page.tsx`
- Institutional learning: `docs/solutions/integration-issues/proxy-matcher-excludes-api-routes.md` — new API routes must be covered by proxy
- Institutional learning: `docs/solutions/ui-bugs/biochoco-overview-horizontal-scroll-map-overlap.md` — layout gotchas for BioChoco tables
