# Camera Trap Project-Level Permissions

**Date:** 2026-02-21
**Status:** Brainstorm complete

## What We're Building

A permission system that scopes camera trap data access by project. Instead of all-or-nothing access to the entire camera trap module, users are assigned to specific camera trap projects (e.g., "Canande", "FCAT") and only see deployments, results, images, and favorites belonging to their assigned projects.

## Why This Approach

Currently, the `projectLabel` field on deployments is purely cosmetic — used for a filter dropdown but not a permission boundary. Any user with `viewer` on the `"camera-trap"` project sees everything. As the system grows with more collaborators working on different geographic areas, users need scoped access to only their relevant data.

## Key Decisions

### 1. Permission Model: Single role + project list
- Users keep one camera-trap role (viewer/editor/admin) that applies across all their assigned projects.
- A separate assignment determines which camera trap projects each user can access.
- This avoids the complexity of per-project roles while still scoping data visibility.

### 2. Schema: Formal camera trap projects table (Approach B)
- Create a `camera_trap_projects` table to formalize project labels as first-class entities with referential integrity.
- Create a `camera_trap_project_access` join table linking users to camera trap projects.
- Change `deployments.projectLabel` to a proper FK to `camera_trap_projects`.
- Migrate existing `projectLabel` values into the new table at deploy time.

### 3. Data Filtering: All views filtered
- Deployments table: only show deployments for assigned projects.
- Processing results: only show jobs for deployments in assigned projects.
- Favorites: only show starred images from assigned projects.
- Species stats: filtered per project context.
- Species list (CRUD): shared across all projects (not filtered).

### 4. Deployment Creation: Locked to assigned projects
- When creating deployments (Drive scan, ODK import, historical import), users select from a dropdown of their assigned projects only.
- This ensures data stays within permission boundaries.

### 5. Admin Management: Extend existing /admin page
- Add camera trap project assignment UI to the existing admin permissions matrix.
- Super admins manage who has access to which camera trap projects.

### 6. Super Admin Bypass
- Super admins see all camera trap projects automatically, consistent with existing behavior.
- No entries needed in the access table for super admins.

### 7. Migration: Manual assignment at launch
- Existing deployments already have `projectLabel` values — these migrate into the new `camera_trap_projects` table.
- User→project assignments are made manually by the admin at launch.
- No auto-assignment of existing users to projects.

## Schema Design

```sql
-- Formal camera trap project entities
CREATE TABLE camera_trap_projects (
  id TEXT PRIMARY KEY,           -- slug, e.g., "canande", "fcat"
  name TEXT NOT NULL,            -- display name, e.g., "Canande", "FCAT"
  created_at TEXT DEFAULT (datetime('now'))
);

-- User access to camera trap projects
CREATE TABLE camera_trap_project_access (
  user_email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  camera_trap_project_id TEXT NOT NULL REFERENCES camera_trap_projects(id) ON DELETE CASCADE,
  PRIMARY KEY (user_email, camera_trap_project_id)
);

-- deployments.project_label becomes a FK
-- ALTER deployments: project_label → camera_trap_project_id (FK)
```

## Query Pattern

```typescript
// Helper: get user's allowed camera trap project IDs
function getUserCameraTrapProjects(user: AuthUser): string[] | "all" {
  if (user.globalRole === "super_admin") return "all";
  // Query camera_trap_project_access for user's projects
}

// Filter deployments
const projects = getUserCameraTrapProjects(user);
const query = db.select().from(deployments)
  .where(projects === "all"
    ? undefined
    : inArray(deployments.cameraTrapProjectId, projects)
  );
```

## Affected Areas

1. **Schema**: New tables + FK migration on deployments
2. **Auth helpers**: New `getUserCameraTrapProjects()` function
3. **Server actions** (~20+ read actions): Add project filtering to all queries
4. **Server actions** (write): Validate user has access to the target deployment's project
5. **Admin page**: New UI section for camera trap project assignments
6. **Deployment creation UI**: Replace free-text projectLabel with dropdown
7. **Drive scan / ODK import**: Require project selection
8. **Navigation**: No change (still gated by `hasProjectAccess("camera-trap")`)

## Open Questions

1. Should camera trap admins (not just super admins) be able to manage project assignments within their module?
2. What happens if a deployment's project label doesn't match any formal project? (Edge case during migration)
3. Should there be a UI for managing camera trap projects themselves (create/rename/delete)?
