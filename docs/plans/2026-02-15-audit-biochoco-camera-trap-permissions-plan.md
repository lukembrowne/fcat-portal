---
title: Audit — BioChoco & Camera Trap User Permissions
type: audit
date: 2026-02-15
---

# Audit: BioChoco & Camera Trap User Permissions

## Permission System Overview

**Role hierarchy:** `viewer (1)` < `editor (2)` < `admin (3)`

- `super_admin` bypasses all checks (set via `SUPER_ADMIN_EMAILS` env or DB `globalRole`)
- `requirePermission(projectId, minRole)` redirects to `/` if user lacks the minimum role
- Pages protect via `requirePermission()` in Server Components
- API routes use `getCurrentUser()` + manual checks (since redirects don't make sense for APIs)

---

## Camera Trap Module

### Pages

| Page | Route | Permission Check | Min Role |
|------|-------|-------------------|----------|
| Main deployments list | `/camera-trap` | **None on page** (uses `getCurrentUser()` for `canEdit` flag; data fetched via actions that check) | viewer (indirect) |
| Deployment detail | `/camera-trap/[id]` | **None on page** (relies on `getDeployment()` action) | viewer (indirect) |
| Process/progress | `/camera-trap/process` | **None** (client component, calls `cancelJob` which checks) | editor (indirect, for cancel) |
| Results list | `/camera-trap/results` | `requirePermission("camera-trap", "viewer")` | viewer |
| Job results detail | `/camera-trap/results/[id]` | `requirePermission("camera-trap", "viewer")` | viewer |
| Image annotation | `/camera-trap/results/[id]/images/[imageId]` | **None on page** (relies on `getImageWithDetections()` etc.) | viewer (indirect) |
| Species management | `/camera-trap/species` | `requirePermission("camera-trap", "editor")` | editor |
| Image API proxy | `/api/ct-images/[id]` | `getCurrentUser()` + manual check (any camera-trap role) | viewer (any role) |

### Server Actions

#### Viewer-level (read-only data access)

| Action | File | Line |
|--------|------|------|
| `getMLStatus` | `actions.ts` | 494 |
| `getDeploymentsWithStats` | `actions.ts` | 820 |
| `getDeployments` | `actions.ts` | 953 |
| `getDeploymentsCascadeStats` | `actions.ts` | 1110 |
| `getJobDeleteStats` | `actions.ts` | 640 |
| `getJobsDeleteStats` | `actions.ts` | 674 |
| `getDistinctProjects` | `actions.ts` | 1281 |
| `getDeployment` | `actions.ts` | 1294 |
| `getRecentJobs` | `actions.ts` | 1318 |
| `getResultsStats` | `actions.ts` | 1382 |
| `getJobWithDetails` | `actions.ts` | 1408 |
| `getImageWithDetections` | `actions.ts` | 1431 |
| `getJobImageIds` | `actions.ts` | 1472 |
| `getSpeciesList` | `actions.ts` | 1672 |
| `getJobSpecies` | `actions.ts` | 1677 |
| `getNextUnverifiedImageId` | `actions.ts` | 1702 |
| `getJobVerificationStats` | `actions.ts` | 1728 |
| `getDeploymentVerificationStats` | `actions.ts` | 1766 |
| `getSpeciesUsageCount` | `actions.ts` | 1929 |
| `getRecentSpecies` | `actions.ts` | 1952 |

#### Editor-level (write/mutate operations)

| Action | File | Line |
|--------|------|------|
| `createProcessingJob` | `actions.ts` | 44 |
| `processJob` | `actions.ts` | 489 |
| `cancelJob` | `actions.ts` | 505 |
| `deleteJob` | `actions.ts` | 566 |
| `deleteJobs` (batch) | `actions.ts` | 714 |
| `updateDeploymentMetadata` | `actions.ts` | 978 |
| `bulkUpdateMetadata` | `actions.ts` | 1020 |
| `deleteDeployments` | `actions.ts` | 1054 |
| `queueProcessing` | `actions.ts` | 1170 |
| `cancelQueue` | `actions.ts` | 1235 |
| `verifyIdentification` | `actions.ts` | 1490 |
| `rejectIdentification` | `actions.ts` | 1520 |
| `correctIdentification` | `actions.ts` | 1551 |
| `bulkVerify` | `actions.ts` | 1582 |
| `bulkVerifyByThreshold` | `actions.ts` | 1617 |
| `createSpecies` | `actions.ts` | 1822 |
| `updateSpecies` | `actions.ts` | 1857 |
| `deleteSpecies` | `actions.ts` | 1889 |
| `createManualDetection` | `actions.ts` | 1983 |
| `verifyAndAdvance` | `actions.ts` | 2048 |
| `syncWithDrive` | `drive-actions.ts` | 25 |
| `scanDeploymentImages` | `drive-actions.ts` | 122 |
| `matchOdkDeployments` | `odk-actions.ts` | 44 |
| `matchAllUnmatched` | `odk-actions.ts` | 183 |

#### Admin-level

**None.** No camera-trap actions require `admin` role.

---

## BioChoco Module

### Pages

| Page | Route | Permission Check | Min Role |
|------|-------|-------------------|----------|
| Root redirect | `/biochoco` | None (just redirects to `/biochoco/overview`) | — |
| Overview/dashboard | `/biochoco/overview` | `requirePermission("biochoco", "viewer")` | viewer |
| Data / Estado de datos | `/biochoco/data` | `requirePermission("biochoco", "viewer")` | viewer |
| Habitat assessments | `/biochoco/habitat` | `requirePermission("biochoco", "viewer")` | viewer |
| Resources/links | `/biochoco/recursos` | `requirePermission("biochoco", "viewer")` | viewer |
| Schedule tools | `/biochoco/tools` | `requirePermission("biochoco", "editor")` | editor |

### Server Actions

#### Viewer-level (read-only data access)

| Action | File | Line |
|--------|------|------|
| `fetchBiochocoData` | `overview/actions.ts` | 16 |
| `fetchHabitatData` | `habitat/actions.ts` | 25 |
| `checkSingleDeployment` | `data/actions.ts` | 26 |
| `fetchSchedule` | `data/actions.ts` | 40 |
| `checkDriveForDeployments` | `data/actions.ts` | 78 |

#### Editor-level (write/mutate operations)

| Action | File | Line |
|--------|------|------|
| `fetchToolsData` | `tools/actions.ts` | 71 |
| `previewBulkShift` | `tools/actions.ts` | 93 |
| `commitBulkShift` | `tools/actions.ts` | 119 |
| `previewDateSwap` | `tools/actions.ts` | 161 |
| `commitDateSwap` | `tools/actions.ts` | 184 |
| `getAvailableSites` | `tools/actions.ts` | 220 |
| `previewAddSite` | `tools/actions.ts` | 246 |
| `commitAddSite` | `tools/actions.ts` | 259 |
| `runValidation` | `tools/actions.ts` | 287 |
| `previewSyncOdk` | `tools/actions.ts` | 355 |
| `commitSyncOdk` | `tools/actions.ts` | 369 |
| `getMissingDriveFolders` | `data/drive-folder-actions.ts` | 129 |
| `createSingleDriveFolder` | `data/drive-folder-actions.ts` | 191 |
| `recreateDriveFolder` | `data/drive-folder-actions.ts` | 291 |

#### Admin-level

**None.** No biochoco actions require `admin` role.

---

## Anomalies & Findings

### 1. Missing page-level permission checks (Camera Trap)

**Severity: Low**

Three Camera Trap pages have no direct `requirePermission()` call:

- `/camera-trap` (main page) — uses `getCurrentUser()` only for `canEdit` flag
- `/camera-trap/[id]` (deployment detail) — no auth check at all
- `/camera-trap/results/[id]/images/[imageId]` (image annotation) — no auth check

These pages are **indirectly protected** because every data-fetching action they call (`getDeploymentsWithStats`, `getDeployment`, `getImageWithDetections`) does check `requirePermission("camera-trap", "viewer")`. So unauthorized users would be redirected once the first action runs.

**Risk:** Unauthorized users briefly see the page shell (header, breadcrumbs, empty layout) before being redirected. No data is leaked.

**Recommendation:** Add `requirePermission("camera-trap", "viewer")` directly to these page components for consistency.

### 2. Process page has no server-side auth (`/camera-trap/process`)

**Severity: Low**

This is a `"use client"` component. It has no server-side permission check. It calls `cancelJob()` (editor) which does check permissions, but the page itself (a progress display) is accessible to anyone who can navigate to the URL.

**Risk:** Very low. The page just shows a progress tracker that would fail to load without permissions. No sensitive data is exposed if the user can't call the actions.

**Recommendation:** Convert to a Server Component wrapper that checks permission before rendering the client component, or add a layout.tsx with permission check.

### 3. CT Image API only checks role existence, not minimum role

**Severity: None (intentional)**

`/api/ct-images/[id]/route.ts` checks `user.permissions.some(p => p.projectId === "camera-trap")` — any role (viewer/editor/admin) grants access. This is correct: viewers should be able to view images.

### 4. `getSpeciesList()` action vs Species page — permission mismatch

**Severity: None (intentional)**

- `getSpeciesList()` action requires `viewer`
- Species management page requires `editor`

This is correct: viewers can see species data (used in annotation views), but the species management UI (create/edit/delete) correctly gates behind `editor`.

### 5. No `admin` role is used in either module

**Severity: Informational**

Neither module uses the `admin` project role for anything. The only modules using `admin` are:
- `finance/data` (upload financial data)
- `finance/cashflow` (some cashflow operations)
- Global `requireAdmin()` (super admin only — `/admin` page)

This means for camera-trap and biochoco, the role hierarchy is effectively just **viewer** and **editor**. An `admin` assignment on these projects behaves identically to `editor` (since admin > editor in the hierarchy, all editor checks pass).

**Recommendation:** This is fine as-is. If you ever need project-level admin operations (e.g., configuring project settings, managing project members), the `admin` role is available.

### 6. `processNextInQueue()` runs without auth

**Severity: None (correct)**

The internal function `processNextInQueue()` and `processJobInternal()` intentionally skip auth checks. They run as fire-and-forget background processing after the initial `queueProcessing()` call verifies editor permission. This is the correct pattern — re-checking auth in a background process would fail since there's no request context.

### 7. All BioChoco pages have direct permission checks

**Severity: None (good)**

Unlike camera-trap, all BioChoco pages have direct `requirePermission()` calls. This is the ideal pattern.

### 8. No rate limiting or audit logging on destructive operations

**Severity: Informational**

Destructive actions like `deleteDeployments`, `deleteJobs`, `deleteSpecies` have no rate limiting or audit trail. BioChoco tools actions (`commitBulkShift`, `commitDateSwap`, etc.) do log to `activityLog`, but camera-trap destructive actions do not.

**Recommendation:** Consider adding activity log entries for camera-trap destructive operations (deleting deployments, jobs, species) for traceability.

---

## Summary Matrix

| Operation | Camera Trap | BioChoco |
|-----------|-------------|----------|
| View pages / dashboards | viewer | viewer |
| View data / read APIs | viewer | viewer |
| View species list | viewer | — |
| View tools page | — | editor |
| Create/process jobs | editor | — |
| Edit metadata | editor | — |
| Verify/annotate | editor | — |
| Manage species | editor | — |
| Manage schedule | — | editor |
| Sync ODK data | editor | editor |
| Create Drive folders | — | editor |
| Delete data | editor | — |
| Admin-level ops | (not used) | (not used) |
| Activity logging | **No** | **Yes** (tools only) |
