---
module: BioChoco
date: 2026-02-24
problem_type: integration_issue
component: service_object
symptoms:
  - "File counts showed fewer files than actually present in Drive folders"
  - "Files in nested subfolders not counted"
  - "Video frame artifacts (_frames/) inflating counts"
  - "JPG vs jpg extensions counted inconsistently"
root_cause: wrong_api
resolution_type: code_fix
severity: medium
tags: [google-drive, api, recursion, pagination, file-counting, shared-drives]
---

# Troubleshooting: Google Drive File Counting — Shallow Listing, Missing Pagination, and Type Filtering

## Problem

The BioChoco data status page showed incorrect file counts for deployment Drive folders. Three separate issues converged: only direct children were counted (no recursion), file type filtering was absent, and video processing artifacts (`_frames/` folders) were inflating counts.

## Environment
- Module: BioChoco data status
- Affected Component: `src/lib/drive-client.ts` — `checkDeploymentUploads()`
- Date: 2026-02-24

## Symptoms
- Camera trap file counts lower than actual (missing nested subfolder files)
- All file types counted equally — Excel files, thumbnails, and actual media all counted
- Video frame extraction folders (`_frames/`) inflating camera trap counts
- Counts inconsistent between uppercase and lowercase file extensions (`.JPG` vs `.jpg`)

## What Didn't Work

**Direct solution:** The root cause was identified by inspecting Drive folder structures and comparing API results with actual folder contents.

## Solution

Replaced shallow `drive.files.list()` with a recursive `countFilesRecursive()` helper that:
1. Traverses folders recursively with depth capping
2. Filters files by extension per data type
3. Handles pagination for folders with >1000 items
4. Skips `_frames/` subfolders

**Code changes:**

```typescript
// Before (broken) — shallow, no filtering:
const filesRes = await drive.files.list({
  q: `'${subfolderId}' in parents and trashed = false`,
  fields: "files(id)",
  pageSize: 1000,
  supportsAllDrives: true,
  includeItemsFromAllDrives: true,
});
const count = filesRes.data.files?.length ?? 0;

// After (fixed) — recursive with type filtering:
async function countFilesRecursive(
  folderId: string,
  extensions: Set<string>,
  depth = 0
): Promise<number> {
  if (depth > 5) return 0; // Prevent pathological nesting

  const drive = getDrive();
  let count = 0;
  const subfolders: { id: string; name: string }[] = [];
  let pageToken: string | undefined;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType)",
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    for (const file of res.data.files ?? []) {
      if (!file.id || !file.name) continue;
      if (file.mimeType === "application/vnd.google-apps.folder") {
        subfolders.push({ id: file.id, name: file.name });
      } else {
        const ext = path.extname(file.name).toLowerCase();
        if (extensions.has(ext)) count++;
      }
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  for (const sub of subfolders) {
    if (sub.name === "_frames") continue; // Skip video frame artifacts
    count += await countFilesRecursive(sub.id, extensions, depth + 1);
  }

  return count;
}
```

**Extension filtering per data type:**

```typescript
const DATA_TYPE_EXTENSIONS: Record<string, Set<string>> = {
  camarasTrampas: new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]),
  grabadoresDeAudio: AUDIO_EXTENSIONS,
  ibutton: IBUTTON_EXTENSIONS, // .xlsx, .csv
};
```

## Why This Works

1. **Root cause (shallow listing):** The original `files.list()` only looked at direct children. Real folder structures have subfolders for different camera stations, dates, etc.

2. **Pagination:** Drive API returns max 1000 items per page. Without the `do...while (pageToken)` loop, folders with >1000 files silently truncate results.

3. **Case-insensitive extensions:** Camera files come in mixed case (`.JPG`, `.jpg`, `.MP4`, `.mp4`). Using `.toLowerCase()` before matching normalizes this.

4. **Depth capping at 5:** Prevents infinite recursion or pathological nesting from hanging the API. Real deployment folders rarely exceed 3 levels deep.

5. **`_frames/` skip:** Video processing tools create intermediate `_frames/` directories with extracted frame images. These are processing artifacts, not user-uploaded data.

## Prevention

- **Always implement pagination** for Drive API `files.list()` calls — use the `do...while (pageToken)` pattern.
- **Always include both Shared Drive flags** on every Drive API call: `supportsAllDrives: true` and `includeItemsFromAllDrives: true`. Without these, Shared Drive folders silently return empty results.
- **Always lowercase file extensions** before comparing. Camera/audio devices use inconsistent casing.
- **Cap recursion depth** to prevent hangs on malformed folder structures.
- **Use `Promise.allSettled()`** when counting across multiple subfolders — one subfolder error shouldn't block others.

## Related Issues

- See also: [MEMORY.md Google Shared Drives gotcha](/Users/luke/.claude/projects/-Users-luke-apps-fcat-portal/memory/MEMORY.md) — the `supportsAllDrives` requirement
