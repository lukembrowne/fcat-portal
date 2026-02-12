# Camera Trap Workflow: Google Drive as Storage Backend

**Date:** 2026-02-11
**Status:** Decided
**Approach:** Google Drive API Direct (no rclone)

## What We're Building

Replace the local-filesystem-based camera trap workflow with a Google Drive-backed architecture. Deployments live as folders on a central FCAT Shared Drive. The portal auto-discovers deployments, recursively scans for images via the Drive API, downloads them to a temp directory for ML processing, and serves images to the browser through a proxy API with local thumbnail caching.

This makes the system **machine-agnostic** — it works identically in Docker, local dev, or any server — and enables **collaborators** to upload images by simply adding files to a shared Drive folder.

## Why This Approach

**Problem:** The current workflow requires users to point to a local filesystem path. This breaks when the app runs in Docker (no access to arbitrary host directories) and is impossible for remote collaborators.

**Chosen approach: Google Drive API Direct** over rclone (mount or copy) because:
- Already have a working Drive client + service account (used for BioChoco)
- No FUSE complexity or Docker privilege escalation needed
- Most portable and debuggable — pure API calls
- File IDs are stable identifiers even if files are renamed/moved
- Deployments are small (<1K images, <5GB) so API-based download is fast enough

**Rejected alternatives:**
- rclone FUSE mount: Fragile in Docker, needs --privileged, mount can silently break
- rclone copy CLI: Adds dependency when Drive API already exists, two ways to talk to Drive

## Key Decisions

1. **Storage backend:** Google Drive Shared Drive (central FCAT-controlled)
2. **Discovery:** Auto-discover deployment folders from a configured root folder ID. Each top-level folder under the root = one deployment.
3. **Image scanning:** Recursively scan entire deployment folder for image files (by extension). Handles both flat layouts (images in root) and nested layouts (images in subfolders like `camaras_trampas/`). No convention about subfolder names needed.
4. **Image identifiers:** Store BOTH Drive file IDs and relative paths in the database. Relative path preserves the folder structure within the deployment (e.g., `camaras_trampas/IMG_001.jpg` or `IMG_001.jpg`).
5. **ML processing:** Pre-sync — download full deployment folder to temp directory, run ML pipeline on local files (no changes to Python code), clean up after.
6. **Image serving:** Proxy through portal API (download from Drive or local cache), with local thumbnail generation/caching.
7. **Users:** FCAT staff + external collaborators who upload images to designated Drive folders.

## Architecture Overview

```
Collaborator uploads images
        |
        v
+---------------------+
|  Google Shared Drive |
|  CameraTraps/       |
|    DeploymentA/      |  <- may have images directly
|      IMG_001.jpg     |
|    DeploymentB/      |  <- or in subfolders
|      camaras_trampas/|
|        IMG_001.jpg   |
|      audio/          |  <- non-image folders ignored
|    DeploymentC/      |
|      ...             |
+--------+------------+
         | Google Drive API
         v
+---------------------+
|   FCAT Portal       |
|                     |
|  Auto-discover      |  <- files.list on root folder (top-level folders only)
|  deployments        |
|                     |
|  Scan images        |  <- recursive files.list on deployment folder
|  (store file IDs +  |     filter by image extensions
|   relative paths)   |     metadata -> DB
|                     |
|  Process:           |  <- Download to /tmp -> ML pipeline -> results to DB -> cleanup
|  1. Sync to temp    |
|  2. Run ML          |
|  3. Store results   |
|  4. Cleanup         |
|                     |
|  Serve images:      |  <- Proxy API: download from Drive + local thumbnail cache
|  /api/images/[id]   |
+---------------------+
```

## Database Changes

### deployments table
- Replace `path` (filesystem path) with:
  - `driveFolderId` — Google Drive folder ID (primary identifier, unique per project)
  - `driveFolderName` — human-readable folder name for display
- Keep: name, latitude, longitude, dateStart, dateEnd, status, totalImages

### images table
- Replace `path` (filesystem path) with:
  - `driveFileId` — Google Drive file ID (primary identifier)
  - `relativePath` — path relative to deployment folder (e.g., "camaras_trampas/IMG_001.jpg" or "IMG_001.jpg")
- Keep: filename, fileSize, fileModified, exifTimestamp, status, thumbnailPath

### Configuration (env vars)
- `CAMERA_TRAP_ROOT_FOLDER_ID` — Drive folder ID for auto-discovery root
- Existing `GOOGLE_SERVICE_ACCOUNT_KEY` — already configured for BioChoco

## Workflow Details

### Auto-Discovery
1. List top-level folders in `CAMERA_TRAP_ROOT_FOLDER_ID`
2. Compare with known deployments in DB (by driveFolderId)
3. Show new/unregistered folders in the UI for activation
4. User can set deployment metadata (name, coordinates, dates) when activating

### Image Scanning
1. Recursively list all files in the deployment folder via Drive API
2. Filter for image extensions (jpg, jpeg, png, etc.)
3. Reconstruct relative paths from Drive folder hierarchy
4. Insert into images table with driveFileId + relativePath
5. Update deployment totalImages count and status -> scanned

### ML Processing (Pre-Sync)
1. Create temp directory: `/tmp/camera-trap-processing/{deploymentId}/`
2. Download all images via Drive API (preserving relative path structure)
3. Run ML pipeline on the temp directory (same Python code, different base path)
4. Store results in DB (detections, identifications)
5. Clean up temp directory

### Image Serving
1. Browser requests `/api/images/{imageId}?size=thumb|full`
2. For thumbnails: check local cache first, generate if missing (download from Drive -> resize -> cache)
3. For full images: download from Drive on demand (or from local cache if recently synced)
4. Stream response with appropriate caching headers

## Open Questions

1. **Thumbnail storage:** Keep thumbnails locally (current approach) or also store in Drive? Local is simpler and faster.
2. **Sync caching:** After pre-syncing for ML processing, keep the local copy around for faster image serving? Or always clean up?
3. **Collaborator onboarding:** How do collaborators get access to upload to the Drive? Manual sharing by FCAT admin?
4. **Existing data migration:** Any existing deployments with local paths that need migrating, or starting fresh?
5. **Rate limits:** Google Drive API allows ~12,000 requests/min per service account. Well within limits at this scale but worth monitoring.

## Next Steps

Run `/workflows:plan` to create a detailed implementation plan.
