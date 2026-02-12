---
title: "feat: Camera Trap UX Polish, Table Prefixes, and ML Defaults"
type: feat
date: 2026-02-12
depends_on: docs/plans/2026-02-11-feat-google-drive-camera-trap-workflow-plan.md
---

# feat: Camera Trap UX Polish, Table Prefixes, and ML Defaults

## Overview

Polish the Google Drive camera trap workflow with terminology changes, table naming consistency, UI improvements, and simplified ML processing. This is a follow-up to the initial Drive integration.

## Changes

### 1. Terminology: "Despliegue" → "Instalación"

Match ODK/BioChoco terminology where "deployment" = "instalación" (installation of a camera at a site).

**Scope**: Only camera trap Spanish UI strings. Do NOT change:
- BioChoco `deploymentId` fields (those are ODK field names)
- English code identifiers (`deployment`, `deploymentId`, `getDeployment`, etc.)
- Database column names (`deployment_id`) — these stay as-is in the DB layer

**Files to update (UI strings only):**

| File | Changes |
|------|---------|
| `src/app/camera-trap/page.tsx` | "Despliegues" → "Instalaciones", "despliegues" → "instalaciones", "despliegue" → "instalación" |
| `src/app/camera-trap/[id]/page.tsx` | "Metadatos del Despliegue" → "Metadatos de la Instalación" |
| `src/app/camera-trap/deployment-discovery.tsx` | "Registrar Despliegue" → "Registrar Instalación", "Detalles del Despliegue" → "Detalles de la Instalación", "carpetas de despliegue" → "carpetas de instalación", "Nombre del despliegue" → "Nombre de la instalación", "Activar Despliegue" → "Activar Instalación" |
| `src/app/camera-trap/drive-actions.ts` | "despliegue" → "instalación" in error messages |
| `src/app/camera-trap/actions.ts` | "Despliegue no encontrado" → "Instalación no encontrada" |
| `src/app/camera-trap/results/page.tsx` | "Despliegue desconocido" → "Instalación desconocida" |
| `src/app/camera-trap/results/[id]/page.tsx` | "Despliegue desconocido" → "Instalación desconocida", "Despliegue" button → "Instalación" |
| `src/components/status-badge.tsx` | Only if it displays Spanish labels for deployment status (check `DEPLOYMENT_STATUS_CONFIG`) |

**Acceptance criteria:**
- [ ] All camera trap UI shows "instalación/instalaciones" instead of "despliegue/despliegues"
- [ ] BioChoco pages are unchanged
- [ ] English code identifiers are unchanged
- [ ] Database column names are unchanged

---

### 2. SQL Table Prefix: `biochoco_` for Camera Trap Tables

Match the naming convention used by finance (`finance_*`) and climate (`climate_*`). Camera traps are part of the BioChoco biodiversity monitoring program.

**Current → New table names:**

| Current | New | Notes |
|---------|-----|-------|
| `deployments` | `biochoco_deployments` | Main camera trap entity |
| `processing_jobs` | `biochoco_processing_jobs` | ML processing jobs |
| `images` | `biochoco_images` | Camera trap images |
| `detections` | `biochoco_detections` | ML detection results |
| `identifications` | `biochoco_identifications` | Species classifications |
| `species` | `biochoco_species` | Species reference table |

**Migration approach**: Since databases are currently empty, just update the CREATE TABLE statements directly. No data migration needed — fresh `push-schema.mjs` run creates tables with new names.

**Files affected:**

| File | What changes |
|------|-------------|
| `src/db/schema.ts` | Table name strings in `sqliteTable()` calls: `"deployments"` → `"biochoco_deployments"`, etc. All index names get `biochoco_` prefix too. |
| `scripts/push-schema.mjs` | All CREATE TABLE/INDEX statements updated. Migration section added to rename existing tables. |
| `src/app/camera-trap/actions.ts` | No code changes needed — Drizzle uses the schema objects, not raw table names |
| `src/app/camera-trap/drive-actions.ts` | No code changes needed (same reason) |
| `src/lib/ml-runner.ts` | No code changes needed |
| `src/lib/drive-downloader.ts` | No code changes needed |
| `src/app/api/ct-images/[id]/route.ts` | No code changes needed |
| `src/app/api/images/[...path]/route.ts` | No code changes needed |
| `src/db/index.ts` | No code changes needed (uses schema objects) |

**Key insight**: Because we use Drizzle ORM, only the schema definition and push-schema.mjs need table name changes. All queries use `schema.deployments`, `schema.images`, etc. which Drizzle maps to the new SQL table names automatically.

**Index renaming:**

| Current | New |
|---------|-----|
| `idx_deployments_project_path` | `idx_biochoco_deployments_project_path` |
| `idx_deployments_project_drive_folder` | `idx_biochoco_deployments_project_drive_folder` |
| `idx_images_deployment_id` | `idx_biochoco_images_deployment_id` |
| `idx_images_job_id` | `idx_biochoco_images_job_id` |
| `idx_images_deployment_drive_file` | `idx_biochoco_images_deployment_drive_file` |
| `idx_detections_image_id` | `idx_biochoco_detections_image_id` |
| `idx_detections_job_id` | `idx_biochoco_detections_job_id` |
| `idx_identifications_detection_id` | `idx_biochoco_identifications_detection_id` |

**Acceptance criteria:**
- [ ] All 6 camera trap tables have `biochoco_` prefix in SQLite
- [ ] All indexes have `biochoco_` prefix
- [ ] `push-schema.mjs` handles migration from old names (idempotent)
- [ ] Drizzle schema reflects new table names
- [ ] All existing queries continue to work (they use schema objects, not raw SQL)
- [ ] `npm run build` passes
- [ ] Exported TypeScript types keep current names (`Deployment`, `Image`, etc.) — only the SQL table names change

---

### 3. Drive Folder Links in UI

Instead of showing the raw Drive folder ID, show a clickable link to open the folder in Google Drive.

**Drive folder URL pattern:**
```
https://drive.google.com/drive/folders/{folderId}
```

**Files to update:**

| File | Current | New |
|------|---------|-----|
| `src/app/camera-trap/page.tsx:114` | `<span>Google Drive</span>` | `<a href="https://drive.google.com/drive/folders/${deployment.driveFolderId}" target="_blank">Abrir en Drive ↗</a>` |
| `src/app/camera-trap/[id]/page.tsx:54-56` | Shows "Google Drive" text | Link: "Abrir carpeta en Drive ↗" |
| `src/app/camera-trap/deployment-discovery.tsx` | Shows folder name + ID in card | Show folder name + "Abrir en Drive ↗" link |

**Acceptance criteria:**
- [ ] Deployment cards show "Abrir en Drive ↗" link instead of "Google Drive" text
- [ ] Deployment detail page shows clickable link to Drive folder
- [ ] Discovery cards show link to open folder in Drive
- [ ] Links open in new tab (`target="_blank"`)

---

### 4. ~~Thumbnails on Deployment Page After Scanning~~ — CUT

**CUT per reviewer feedback.** The existing image proxy at `/api/ct-images/[id]` already handles thumbnail generation lazily (download from Drive on cache miss → generate with `sharp` → cache → serve). At ~5 users, Drive API rate limits are a non-issue. Just ensure `loading="lazy"` on image tags in `ImageGrid`.

---

### 5. Redesigned Main Page: Two-Group Folder View

Replace the current "Buscar Nuevas Carpetas" wizard with an always-visible two-group layout showing all Drive folders.

**Current flow** (problematic):
1. User clicks "Buscar Nuevas Carpetas" button
2. Waits for Drive API call
3. Sees list of unregistered folders in a small card
4. Clicks "Activar" on one

**New flow:**
1. Page loads → calls Drive API to list all folders in root
2. Merges with DB data (which are activated, scanned, processed, etc.)
3. Shows ALL folders in two groups:
   - **Pendientes** — folders not yet activated or not yet processed
   - **Procesadas** — folders that have been fully processed
4. Each folder card shows: name, link to Drive, image count (if scanned), status badge
5. "Sincronizar con Drive" button to refresh the folder list

**Architecture decision: DB-first rendering (per reviewer feedback)**

Do NOT call Drive API on every page load — it blocks server component render on an external API. Instead:
- Page loads from DB only (`getDeployments()`) — instant render
- "Sincronizar con Drive" button triggers `discoverDeployments()` via Client Component
- Discovered folders merged into the UI when the Drive response arrives
- This matches the existing pattern but with better UX (two-group layout instead of sidebar wizard)

**Implementation:**

1. **Modify `discoverDeployments()`** in `drive-actions.ts`:
   - Already returns `{ known: Deployment[], discovered: DriveFolder[] }`
   - Add status grouping: split `known` into `processed` and `pending` based on `deployment.status`

2. **Rewrite `page.tsx`** main layout:
   - Remove the sidebar `DeploymentDiscovery` widget
   - Call `discoverDeployments()` at the top level (server component)
   - Show two sections:
     - "Carpetas Pendientes" — discovered (unactivated) + activated but not processed
     - "Carpetas Procesadas" — status in ('processed', 'verified')
   - Each card is clickable: unactivated → opens activation form, activated → links to deployment detail page

3. **Simplify `DeploymentDiscovery`** → `ActivationForm` (Client Component):
   - Only handles the activation form (metadata entry)
   - Triggered by clicking on an unactivated folder card
   - No discovery step needed (folders already loaded on page)

4. **Add "Sincronizar con Drive" button** — just revalidates the page (calls `revalidatePath('/camera-trap')`)

**Wireframe:**

```
┌─────────────────────────────────────────────────────────────┐
│ Cámaras Trampa                          [Sincronizar ↻]    │
│                                                             │
│ ┌─── Estadísticas ────────────────────────────────────────┐ │
│ │ Instalaciones: 12 │ Imágenes: 5,432 │ Procesadas: 8    │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│ ── Pendientes (4) ──────────────────────────────────────── │
│ ┌─────────────────┐ ┌─────────────────┐ ┌────────────────┐ │
│ │ CamTrap_Sitio5  │ │ CamTrap_Sitio6  │ │ CamTrap_Sitio7 │ │
│ │ 📁 Nueva        │ │ ⏳ Escaneada    │ │ 📁 Nueva       │ │
│ │ Abrir en Drive ↗│ │ 234 imágenes    │ │ Abrir en Drive↗│ │
│ │ [Activar]       │ │ Abrir en Drive ↗│ │ [Activar]      │ │
│ └─────────────────┘ └─────────────────┘ └────────────────┘ │
│                                                             │
│ ── Procesadas (8) ──────────────────────────────────────── │
│ ┌─────────────────┐ ┌─────────────────┐ ┌────────────────┐ │
│ │ CamTrap_Sitio1  │ │ CamTrap_Sitio2  │ │ CamTrap_Sitio3 │ │
│ │ ✅ Procesada    │ │ ✅ Verificada   │ │ ✅ Procesada   │ │
│ │ 456 imágenes    │ │ 312 imágenes    │ │ 189 imágenes   │ │
│ │ 12 especies     │ │ 8 especies      │ │ 15 especies    │ │
│ │ Abrir en Drive ↗│ │ Abrir en Drive ↗│ │ Abrir en Drive↗│ │
│ └─────────────────┘ └─────────────────┘ └────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**Files affected:**

| File | Changes |
|------|---------|
| `src/app/camera-trap/page.tsx` | Full rewrite of layout — two groups, no sidebar |
| `src/app/camera-trap/drive-actions.ts` | Extend `discoverDeployments()` return type with grouping |
| `src/app/camera-trap/deployment-discovery.tsx` | Simplify to just the activation form (no discovery step) |

**Acceptance criteria:**
- [ ] Page loads shows all Drive folders (API call on load)
- [ ] Folders grouped into "Pendientes" and "Procesadas"
- [ ] Unactivated folders show "Activar" button
- [ ] Activated folders link to deployment detail page
- [ ] "Sincronizar con Drive" button refreshes the list
- [ ] Each folder card shows Drive link
- [ ] Stats cards show totals

---

### 6. Simplified ML Processing (MVP Defaults)

Remove the ML configuration dialog. Hardcode defaults for the MVP.

**Defaults:**
- Detector: `MDV6-yolov9-c` (MegaDetector V6 YOLOv9-c)
- Classifier: `AI4GAmazonRainforest`
- Confidence threshold: `0.1`

**Implementation:**

1. **Replace `ProcessButton` dialog** with a simple button:
   - Remove `Dialog`, `Select` components, `DETECTOR_MODELS`, `CLASSIFIER_MODELS` constants
   - Button calls `createProcessingJob(deploymentId, { detectorModel: "MDV6-yolov9-c", classifierModel: "AI4GAmazonRainforest", confidenceThreshold: 0.1 })` directly
   - Keep the ML availability check (`getMLStatus()`) — show it as an inline warning if ML is unavailable, not in a dialog

2. **Simplify the processing flow**:
   - Click "Procesar Imágenes" → confirms with a simple `window.confirm()` or inline prompt → starts processing
   - Redirect to process page as before

**Files to update:**

| File | Changes |
|------|---------|
| `src/app/camera-trap/[id]/process-button.tsx` | Remove dialog, selects, slider. Simple button with hardcoded config. |

**Acceptance criteria:**
- [ ] "Procesar Imágenes" button starts processing with hardcoded defaults (no config dialog)
- [ ] ML status check still runs — button disabled if ML unavailable
- [ ] Clear error message if ML not available
- [ ] Processing job uses: MDV6-yolov9-c, AI4GAmazonRainforest, 0.1 threshold

---

### 7. ML in Docker — Auto-Install with `uv` at Startup

**Current state**: ML Python venv is mounted from the host as a read-only Docker volume at `/ml-venv`. The Docker image only has `python3` (Alpine). If the host venv doesn't exist, ML silently fails.

**Approach: Install ML dependencies on-demand using `uv` (fast Python package manager).**

The venv lives in `data/ml-venv/` (persisted via Docker volume). On first startup, if the venv doesn't exist, it's created automatically. Subsequent restarts reuse the existing venv.

**How it works:**

1. Install `uv` in the Docker image (single binary, ~10MB)
2. Add a startup script (`scripts/ensure-ml-venv.sh`) that checks for `data/ml-venv/bin/python3`
3. If missing, run `uv venv data/ml-venv && uv pip install --python data/ml-venv/bin/python3 torch torchvision --index-url https://download.pytorch.org/whl/cpu && uv pip install --python data/ml-venv/bin/python3 PytorchWildlife`
4. Set `ML_PYTHON_PATH=data/ml-venv/bin/python3`

**Benefits:**
- Docker image stays small (~200MB, no PyTorch baked in)
- ML venv persists in `data/` volume across container restarts (only installs once)
- Self-healing: if venv is corrupted, delete `data/ml-venv/` and restart
- `uv` is ~10-50x faster than `pip` for installing PyTorch (~2 min vs 10+ min)
- No host dependency — works on any machine
- CPU-only for now (DigitalOcean has no GPU)

**Startup script (`scripts/ensure-ml-venv.sh`):**

```bash
#!/bin/sh
set -e

ML_VENV_DIR="${ML_VENV_DIR:-data/ml-venv}"
ML_PYTHON="$ML_VENV_DIR/bin/python3"

# Check if venv already exists and has pytorch-wildlife
if [ -x "$ML_PYTHON" ]; then
  if "$ML_PYTHON" -c "import PytorchWildlife" 2>/dev/null; then
    echo "[ml-setup] ML venv ready at $ML_VENV_DIR"
    exit 0
  fi
  echo "[ml-setup] ML venv exists but PytorchWildlife missing, reinstalling..."
fi

echo "[ml-setup] Creating ML venv at $ML_VENV_DIR..."
uv venv "$ML_VENV_DIR"
echo "[ml-setup] Installing PyTorch (CPU)..."
uv pip install --python "$ML_PYTHON" torch torchvision --index-url https://download.pytorch.org/whl/cpu
echo "[ml-setup] Installing PytorchWildlife..."
uv pip install --python "$ML_PYTHON" PytorchWildlife
echo "[ml-setup] ML venv ready!"
```

**Docker entrypoint integration:**

```dockerfile
# In Dockerfile runner stage:
RUN apk add --no-cache python3 curl
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
COPY scripts/ensure-ml-venv.sh ./scripts/

# In docker-entrypoint.sh (or CMD):
# Run ensure-ml-venv.sh before starting the server
```

**Files to update:**

| File | Changes |
|------|---------|
| `Dockerfile` | Add `uv` installation |
| `scripts/ensure-ml-venv.sh` | New file — ML venv setup script |
| `docker-compose.yml` | Remove `ML_VENV_PATH` volume mount, set `ML_PYTHON_PATH=data/ml-venv/bin/python3` |
| `docker-entrypoint.sh` | Call `ensure-ml-venv.sh` before `node server.js` (or create entrypoint if none exists) |
| `CLAUDE.md` | Update ML docs — auto-installed, no host dependency |

**Acceptance criteria:**
- [ ] Fresh container auto-installs ML dependencies on first startup
- [ ] Subsequent restarts reuse existing venv (no re-install)
- [ ] `checkPytorchWildlife()` returns available after startup
- [ ] Processing jobs complete successfully in Docker
- [ ] Deleting `data/ml-venv/` and restarting triggers reinstall
- [ ] Docker image stays under 300MB (ML deps in volume, not image)

---

## Reviewer Recommendations (incorporated)

- **DHH**: If doing Docker ML, run `ensure-ml-venv.sh &` in background so app starts immediately
- **Kieran**: ML defaults → shared constants or server action (single source of truth); wrap `scanDeploymentImages` inserts in a transaction
- **All 3**: Don't block server component render on Drive API call — load from DB, sync on demand

## Implementation Phases

### Phase 1: Table Prefix + Terminology (schema + strings)
- [ ] Update `src/db/schema.ts` table names to `biochoco_*` prefix
- [ ] Update `scripts/push-schema.mjs` CREATE TABLE/INDEX statements (DBs are empty — no migration needed, just update the statements)
- [ ] Run `npm run build` to verify Drizzle resolves correctly
- [x] Replace "despliegue" → "instalación" in all camera trap UI files
- [x] Verify BioChoco pages unchanged

### Phase 2: UI Improvements
- [x] Add Drive folder links (replace "Google Drive" text with clickable links)
- [x] Redesign main page: DB-first two-group layout, "Sincronizar con Drive" button
- [x] Ensure `loading="lazy"` on ImageGrid thumbnails

### Phase 3: ML Simplification
- [x] Remove ProcessButton dialog, hardcode defaults in shared constants
- [x] ML defaults as single source of truth (server action or constants file)

### Phase 4: Docker ML with uv
- [x] Create `scripts/ensure-ml-venv.sh`
- [x] Update Dockerfile to install `uv`
- [x] Create `docker-entrypoint.sh` — run ML setup in background, start Node immediately
- [x] Update `docker-compose.yml` — remove host venv volume mount
- [x] Ensure `data/ml-venv/` is writable by container user

## References

### Internal References
- Previous plan: `docs/plans/2026-02-11-feat-google-drive-camera-trap-workflow-plan.md`
- Schema: `src/db/schema.ts`
- Push schema: `scripts/push-schema.mjs`
- Camera trap pages: `src/app/camera-trap/`
- ML runner: `src/lib/ml-runner.ts`
- Docker: `Dockerfile`, `docker-compose.yml`

### Institutional Learnings
- Worktree bootstrap: `docs/solutions/build-errors/git-worktree-missing-gitignored-files.md`
- push-schema.mjs migration ordering: Drive indexes must come after ALTER TABLE
