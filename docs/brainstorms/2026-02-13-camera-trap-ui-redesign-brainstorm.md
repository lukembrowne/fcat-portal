# Camera Trap UI Redesign

**Date:** 2026-02-13
**Status:** Brainstorm complete

## What We're Building

A redesigned camera trap module that replaces the current card-based dashboard + multi-step activation flow with a **table-driven interface** featuring:

- **Deployment table** as the primary interface, with columns for name, project, site, status, image count, last processed date, location, and deployment dates
- **Side panel** that slides open when clicking a row, showing full deployment details, processing job history, and quick actions
- **Multi-select** for batch processing (sequential queue) and batch metadata editing
- **ODK auto-matching** to enrich deployments with metadata from BioChoco `instalar_sensores` submissions
- **DB as source of truth** with Drive sync adding new rows and ODK enriching existing ones

## Why This Approach

The current UX has too many steps: discover → click folder → fill form → activate → navigate to detail → process. The new design puts everything in one table where users can see all deployments at a glance, select multiple for processing, and manage metadata without navigating away.

Key motivations:
- Eliminate the activation ceremony — Drive sync should just create rows
- Surface processing status and history without page navigation
- Enable batch operations for efficiency
- Pull in ODK metadata automatically instead of manual entry
- Support multiple camera trap projects in the future

## Key Decisions

1. **DB is the source of truth.** The table shows only DB records. "Sync with Drive" discovers new folders and creates deployment rows. ODK matching enriches rows with metadata. Drive/ODK never overwrite user-edited data.

2. **Project is a metadata field**, not a Drive folder structure requirement. Assigned via ODK auto-match or manual edit. The single Drive root folder stays flat.

3. **Side panel for details**, not accordion rows. Clicking a row opens a slide-over panel showing deployment metadata, processing job list (mini-table with date, model, status, species count, "View Results" link), and action buttons.

4. **Simple sequential queue for batch processing.** Select multiple deployments → "Process Selected" → they queue and run one after another. Progress indicator shows current job and queue position.

5. **Auto-match ODK by name/date.** When syncing, try to correlate Drive folder names and dates with `instalar_sensores` ODK submissions to auto-fill GPS, site name, and date range. Heuristic matching, not exact.

6. **ODK-to-Drive folder creation is out of scope.** That automation (ODK submission → create Drive folder structure) belongs in a separate BioChoco monitoring module. Camera trap page just consumes existing folders.

7. **Multi-select batch edit.** Select rows → "Edit Selected" → bulk-set project, location, dates. Individual editing also available in the side panel.

## UI Layout

```
+------------------------------------------------------------------+
|  Camera Trap Deployments                    [Sync with Drive]     |
|  [Filter by project v] [Filter by status v] [Search...]          |
+------------------------------------------------------------------+
|  [ ] | Name           | Project  | Status    | Images | Last Run |
|  [x] | Instalacion-01 | BioChoco | Processed |   342  | 2026-01 |
|  [x] | Instalacion-02 | BioChoco | Scanned   |   128  | —       |
|  [ ] | Trail-cam-N    | BioChoco | New       |    —   | —       |
|  [ ] | Reserva-X-01   | (none)   | New       |    —   | —       |
+------------------------------------------------------------------+
|  [2 selected]  [Process Selected]  [Edit Selected]  [Delete]     |
+------------------------------------------------------------------+
```

When a row is clicked, side panel slides in from the right:

```
+-------------------------------------------+----------------------+
|  Table (narrowed)                         |  SIDE PANEL          |
|                                           |  Instalacion-01      |
|                                           |  Status: Processed   |
|                                           |  Project: BioChoco   |
|                                           |  Site: Cerro Alto    |
|                                           |  GPS: -0.12, -79.45  |
|                                           |  Dates: 2025-11 to   |
|                                           |         2025-12      |
|                                           |  Images: 342         |
|                                           |  [Edit] [Process]    |
|                                           |                      |
|                                           |  Processing History  |
|                                           |  +------------------+|
|                                           |  | Date  | Status  ||
|                                           |  | 01-15 | Done ✓  ||
|                                           |  | 01-10 | Failed  ||
|                                           |  +------------------+|
|                                           |  [View Results →]    |
+-------------------------------------------+----------------------+
```

## Data Flow

1. **Page load**: Query `biochoco_deployments` table → render table
2. **Sync with Drive**: `discoverDeployments()` → create new DB rows (status: `unscanned`) → attempt ODK auto-match → update rows with matched metadata
3. **ODK auto-match**: Fetch `instalar_sensores` submissions → match by folder name similarity + date overlap → enrich deployment with GPS, site name, dates. Never overwrite user-edited fields.
4. **Scan images**: On first process or explicit action, recursively scan Drive folder for images → populate `biochoco_images`
5. **Batch process**: Create jobs for selected deployments → sequential queue → process one at a time → floating progress shows queue status
6. **View results**: From side panel job list → navigate to existing `/camera-trap/results/[id]` page

## Schema Changes Needed

- Add `ct_project` text column to `biochoco_deployments` (or repurpose `project_id` which is currently always `"camera-trap"`)
- Add `site_name` text column to `biochoco_deployments`
- Add `odk_submission_id` text column for ODK linkage
- Add `metadata_source` text column (`manual`, `odk`, `drive`) to track where data came from
- Consider a `processing_queue` table or just use job status ordering

## Open Questions

- **ODK matching heuristics**: What fields from `instalar_sensores` map to deployment metadata? Need to inspect the actual form structure. How fuzzy should name matching be?
- **Queue persistence**: If the server restarts mid-queue, should remaining queued jobs auto-resume or require user re-initiation?
- **Project management**: Should there be an admin page for managing camera trap projects (name, description, default Drive folder), or just use the metadata field with free-text entry for now?
- **Results integration**: Keep navigating to `/camera-trap/results/[id]` for full results, or eventually bring a summary into the side panel?
