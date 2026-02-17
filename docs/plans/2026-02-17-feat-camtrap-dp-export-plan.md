---
title: "feat: Camtrap DP export for camera trap deployments"
type: feat
date: 2026-02-17
brainstorm: docs/brainstorms/2026-02-17-camtrap-dp-export-brainstorm.md
---

# Camtrap DP Export for Camera Trap Module

## Overview

Add a data export feature to the main camera trap deployments page (`/camera-trap`) that generates a [Camtrap DP](https://camtrap-dp.tdwg.org/) compliant ZIP containing `deployments.csv`, `media.csv`, `observations.csv`, and `datapackage.json`. The export is triggered from the selection toolbar after selecting deployments. Accessible to all roles (viewer+).

## Proposed Solution

A server-side API route (`GET /api/camera-trap/export?ids=1,2,3`) generates the ZIP. The deployments table gets an "Exportar Camtrap DP" button in the selection toolbar. Row selection checkboxes are enabled for all roles (not just editors). All logic — queries, CSV builders, ZIP generation — lives in the single route file.

No "Export All" button in v1. Users can select-all via the header checkbox, then export. Simpler: one button, one code path.

## Phase 1: Server-Side API Route

### 1a. Add `fflate` dependency

```bash
npm install fflate
```

Zero-dependency, 2KB gzipped ZIP library. Works in Node.js. No `@types` needed (ships its own).

### 1b. Create API route — `src/app/api/camera-trap/export/route.ts`

Self-contained file: auth → queries → CSV builders → ZIP → response. No separate utility module, no server action indirection.

**Endpoint:**
```
GET /api/camera-trap/export?ids=1,2,3
```

**Auth pattern** (follows `ct-images` route — NOT `requirePermission()` which redirects):
```typescript
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const hasAccess = user.globalRole === "super_admin" ||
    user.permissions.some(p => p.projectId === "camera-trap");
  if (!hasAccess) return NextResponse.json({ error: "Acceso denegado" }, { status: 403 });
  // ...
}
```

**Input validation:**
- Parse `ids` param, validate each as integer
- Cap at 500 IDs max (return 400 if exceeded)
- Filter to processed statuses only (`processed`, `verified`, `verified_empty`)
- Return 400 if zero valid deployments: `{ error: "No hay instalaciones procesadas para exportar" }`

**Query strategy** — 3 sequential queries (not one mega-join):

1. **Deployments**: `SELECT * FROM biochoco_deployments WHERE id IN (ids) AND status IN ('processed', 'verified', 'verified_empty')`

2. **Media (images)**: `SELECT images.*, videos.filename as videoFilename FROM biochoco_images LEFT JOIN biochoco_videos ON images.videoId = videos.id WHERE images.deploymentId IN (validIds)`

3. **Observations**: `SELECT detections.*, identifications.*, images.deploymentId, images.exifTimestamp, images.fileModified FROM biochoco_detections INNER JOIN biochoco_images ON detections.imageId = images.id LEFT JOIN biochoco_identifications ON identifications.detectionId = detections.id WHERE images.deploymentId IN (validIds) AND (identifications.verificationStatus IS NULL OR identifications.verificationStatus != 'rejected')`

   **JOIN notes:**
   - `LEFT JOIN` from detections to identifications — a detection without an identification (edge case from failed ML) still gets exported with `observationType` based on `detectionClass`
   - Filter out `rejected` identifications but keep detections with no identification at all

**CSV builder functions** (private, inline in the route file):

Helper:
```typescript
function csvValue(val: string | number | boolean | null | undefined): string {
  if (val === null || val === undefined) return '""';
  const str = String(val);
  return `"${str.replace(/"/g, '""')}"`;
}

function rowsToCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  return "\uFEFF" + [
    headers.join(","),
    ...rows.map(row => row.map(csvValue).join(","))
  ].join("\n");
}
```

**Key field mappings:**

| observations.csv field | Logic |
|---|---|
| `observationID` | `"det-{detection.id}"` for detections, `"blank-{image.id}"` for blanks |
| `observationType` | detectionClass 0/1→`"animal"`, 2→`"human"`, 3→`"vehicle"`, blanks→`"blank"` |
| `scientificName` | `COALESCE(correctedSpecies, species)` — only for animal observations |
| `classificationMethod` | `"human"` if verified/corrected, `"machine"` if unverified or no identification |
| `classifiedBy` | `verifiedBy` if human, `modelVersion` if machine |
| `classificationProbability` | `identification.confidence` |
| `eventStart` / `eventEnd` | `image.exifTimestamp ?? image.fileModified ?? deployment.dateStart` + `T00:00:00Z` if date-only |
| `bboxX/Y/Width/Height` | detection bbox fields (normalized 0-1) |

| media.csv field | Logic |
|---|---|
| `mediaID` | `String(image.id)` |
| `deploymentID` | `String(image.deploymentId)` |
| `timestamp` | `image.exifTimestamp ?? image.fileModified ?? deployment.dateStart` |
| `filePath` | `image.filename` (reference only — images not bundled) |
| `filePublic` | `false` |
| `fileName` | `image.filename` |
| `fileMediatype` | `"image/jpeg"` |
| `captureMethod` | `"activityDetection"` for video frames (where `videoId` is set), omit otherwise |
| `mediaComments` | For video frames: `"Extracted from video: {videoFilename}, frame {frameIndex}"` |

| deployments.csv field | Logic |
|---|---|
| `deploymentID` | `String(deployment.id)` |
| `locationID` | `deployment.siteName ?? ""` |
| `locationName` | `deployment.name` |
| `latitude` / `longitude` | `deployment.latitude ?? ""` / `deployment.longitude ?? ""` (non-strict) |
| `deploymentStart` / `deploymentEnd` | ISO 8601. If date-only, append `T00:00:00Z` |
| `deploymentComments` | `deployment.projectLabel ?? ""` |

**Blank observation logic:**
- After building detection-based rows, compute the set of `imageId`s that have at least one non-rejected observation
- For every image NOT in that set, OR with `confirmedBlank: true`, emit one blank row: `observationType: "blank"`, no scientificName, no bbox

**datapackage.json** — mostly static template:
```typescript
const datapackage = {
  profile: "https://rs.gbif.org/sandbox/data-packages/camtrap-dp/1.0/profile/camtrap-dp-profile.json",
  name: "fcat-camera-trap-export",
  title: "FCAT Camera Trap Data Export",
  created: new Date().toISOString(),
  licenses: [{ name: "CC-BY-4.0", path: "https://creativecommons.org/licenses/by/4.0/" }],
  project: { title: "FCAT Camera Trap Monitoring" },
  temporal: {
    start: minDeploymentStart,  // computed from data
    end: maxDeploymentEnd,      // computed from data
  },
  resources: [
    { name: "deployments", path: "deployments.csv" },
    { name: "media", path: "media.csv" },
    { name: "observations", path: "observations.csv" },
  ],
};
```

Skip bounding box computation and taxonomic scope for v1 — deployment coordinates are in `deployments.csv` and species are in `observations.csv`. Can add later if needed for GBIF submission.

**ZIP generation** using `fflate`:
```typescript
import { zipSync, strToU8 } from "fflate";

const zipData = zipSync({
  "deployments.csv": strToU8(deploymentsCsv),
  "media.csv": strToU8(mediaCsv),
  "observations.csv": strToU8(observationsCsv),
  "datapackage.json": strToU8(JSON.stringify(datapackage, null, 2)),
});

return new Response(zipData, {
  headers: {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="camtrap-dp-${date}.zip"`,
  },
});
```

`fflate.zipSync` returns a `Uint8Array` which `Response` accepts directly. No Node-to-Web stream conversion needed.

## Phase 2: UI Integration

### 2a. Enable row selection for all roles — `src/app/camera-trap/deployments-table.tsx`

```typescript
// Before
enableRowSelection: canEdit,

// After
enableRowSelection: true,
```

The selection toolbar actions (process, edit, delete) are already gated by `canEdit` checks. Export will be the only action visible to viewers.

### 2b. Add export button — `src/app/camera-trap/deployments-table.tsx`

One button in the **selection toolbar** (alongside existing buttons, around line 520):

```tsx
<Button variant="outline" size="sm" onClick={handleExport} disabled={exporting}>
  <Download className="mr-2 h-4 w-4" />
  {exporting ? "Exportando..." : "Exportar Camtrap DP"}
</Button>
```

Always visible in the selection toolbar (not gated by `canEdit`). Tooltip: `"Descargar un paquete de datos estandarizado (Camtrap DP)"`

### 2c. Export handler

```typescript
async function handleExport() {
  const allSelected = table.getFilteredSelectedRowModel().rows;
  const processedStatuses = new Set(["processed", "verified", "verified_empty"]);

  // Filter client-side — show warning for excluded deployments
  const valid = allSelected.filter(r => processedStatuses.has(r.original.status));
  const excluded = allSelected.length - valid.length;

  if (valid.length === 0) {
    toast.error("No hay instalaciones procesadas para exportar");
    return;
  }

  if (excluded > 0) {
    toast.info(`${excluded} instalación(es) sin procesar no incluida(s)`);
  }

  setExporting(true);
  try {
    const ids = valid.map(r => r.original.id).join(",");
    const response = await fetch(`/api/camera-trap/export?ids=${ids}`);

    if (!response.ok) {
      let msg = "Error al exportar";
      try { msg = (await response.json()).error || msg; } catch {}
      toast.error(msg);
      return;
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `camtrap-dp-${new Date().toISOString().split("T")[0]}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);

    toast.success("Exportación completada");
  } catch {
    toast.error("Error al exportar los datos");
  } finally {
    setExporting(false);
  }
}
```

**Key details:**
- Client-side filtering of unprocessed deployments (no custom server headers)
- `setTimeout` on `URL.revokeObjectURL` for browser safety
- Error response JSON parsing wrapped in try-catch
- Loading state disables button + shows "Exportando..."

## Acceptance Criteria

- [x] `GET /api/camera-trap/export?ids=1,2,3` returns a valid ZIP with 4 files
- [x] ZIP contains well-formed `deployments.csv`, `media.csv`, `observations.csv`, `datapackage.json`
- [x] Rejected identifications excluded from `observations.csv`
- [x] Corrected species use `COALESCE(correctedSpecies, species)`
- [x] Images with no non-rejected observations produce `observationType: "blank"` rows
- [x] `confirmedBlank` images produce blank observation rows
- [x] MegaDetector classes map: 0/1→animal, 2→human, 3→vehicle
- [x] Detections without identifications still appear (LEFT JOIN)
- [x] Video-extracted frames appear in `media.csv` with source video info
- [x] Missing timestamps fall back to `fileModified` then `dateStart`
- [x] Viewers can select deployments and export (checkboxes enabled for all roles)
- [x] "Exportar Camtrap DP" appears in selection toolbar (visible to all roles)
- [x] Unprocessed deployments in selection are excluded with client-side toast
- [x] Empty result (zero valid deployments) shows clear error message
- [x] API returns 401/403 for unauthenticated/unauthorized requests
- [x] API validates IDs as integers, caps at 500 max
- [x] Export works for deployments with missing lat/lng or dates (empty CSV values)

## Technical Considerations

- **Performance**: 3 separate queries avoid a massive join. SQLite `busy_timeout` of 5000ms handles concurrent reads.
- **Memory**: CSV strings built in memory, ZIP generated synchronously via `fflate.zipSync`. Fine for expected data volumes (text CSV for hundreds of deployments is small).
- **Security**: API route uses `getCurrentUser()` + manual permission check. Deployment IDs validated as integers, capped at 500.
- **No new client dependencies**: `fflate` is server-only (used in the API route). Client uses the existing blob download pattern.
- **No changes to `actions.ts`**: All export logic self-contained in the route file.

## Files to Create/Modify

| File | Action | Description |
|---|---|---|
| `src/app/api/camera-trap/export/route.ts` | **Create** | API route: auth, queries, CSV builders, ZIP generation |
| `src/app/camera-trap/deployments-table.tsx` | **Modify** | `enableRowSelection: true`, add export button + handler |
| `package.json` | **Modify** | Add `fflate` |

## References

- [Camtrap DP specification](https://camtrap-dp.tdwg.org/)
- [Camtrap DP GitHub repo (schemas)](https://github.com/tdwg/camtrap-dp)
- Brainstorm: `docs/brainstorms/2026-02-17-camtrap-dp-export-brainstorm.md`
- Existing CSV pattern: `src/app/giz/tree-planting/tree-table.tsx:64-111`
- Existing API auth pattern: `src/app/api/ct-images/[id]/route.ts:44-55`
