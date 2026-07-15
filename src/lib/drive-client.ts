/**
 * Google Drive client for BioChoco upload status and Camera Trap workflows.
 *
 * Singleton Drive API client using the same service account as sheets-client.
 * Own copy of getServiceAccountKey() to avoid coupling the two modules.
 */

import "server-only";

import { google, type drive_v3 } from "googleapis";
import { promises as fs, createReadStream } from "fs";
import path from "path";
import { Readable } from "stream";
import type { ActionResult } from "./types";
import { log } from "@/lib/log";
import {
  DATA_TYPE_FOLDERS,
  AUDIO_CALIBRATION_FOLDER,
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  AUDIO_EXTENSIONS,
  DATA_TYPE_EXTENSIONS,
} from "./drive-routing";

// Re-exported so existing consumers (e.g. audio sync) keep importing it from here.
export { AUDIO_EXTENSIONS };

// --- Types ---

export interface UploadStatus {
  camarasTrampas: number | null; // file count, null = subfolder not found or check failed
  grabadoresDeAudio: number | null;
  ibutton: number | null;
  // Audio-calibration folder. Optional so the out-of-scope UploadStatus literal
  // constructors (e.g. the nightly-refresh email path) compile unchanged.
  calibracionDeAudio?: number | null;
  camarasTrampasSizeBytes: number | null;
  grabadoresDeAudioSizeBytes: number | null;
  ibuttonSizeBytes: number | null;
  calibracionDeAudioSizeBytes?: number | null;
  camarasTrampasNewestDate: string | null;
  grabadoresDeAudioNewestDate: string | null;
  ibuttonNewestDate: string | null;
  calibracionDeAudioNewestDate?: string | null;
  subfolderIds: {
    camarasTrampas: string | null;
    grabadoresDeAudio: string | null;
    ibutton: string | null;
    calibracionDeAudio?: string | null;
  };
}

interface FileStats {
  count: number;
  totalBytes: number;
  newestDate: string | null;
}

// Subfolder names + extension routing now live in ./drive-routing (shared with
// the field-upload endpoint). Imported above.

// --- Auth ---

function getServiceAccountKey(): Record<string, string> {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not configured");
  return JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
}

// --- Singleton client ---

let driveClient: drive_v3.Drive | null = null;

function getDrive(): drive_v3.Drive {
  if (driveClient) return driveClient;

  const key = getServiceAccountKey();
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });

  driveClient = google.drive({ version: "v3", auth });
  return driveClient;
}

// --- Public API ---

/**
 * Extract the folder ID from a Google Drive folder URL.
 *
 * Handles:
 * - https://drive.google.com/drive/folders/{id}
 * - https://drive.google.com/drive/folders/{id}?usp=sharing
 * - https://drive.google.com/drive/u/0/folders/{id}
 */
export function extractFolderId(driveUrl: string): string | null {
  if (!driveUrl) return null;

  const match = driveUrl.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

/**
 * Resolve which Shared Drive a folder/file physically lives in.
 *
 * Returns the `0A…` Shared Drive ID, or null if the item is in My Drive (no
 * shared drive) or can't be read. Authoritative per-folder — used to map a
 * deployment's existing upload folders to their host drive WITHOUT trusting any
 * stored routing, so it stays correct when a project spans multiple drives.
 */
export async function resolveFolderDriveId(folderId: string): Promise<string | null> {
  const drive = getDrive();
  const res = await withRetry(
    () =>
      drive.files.get({
        fileId: folderId,
        fields: "driveId",
        supportsAllDrives: true,
      }),
    `files.get.driveId(${folderId})`,
  );
  return res.data.driveId ?? null;
}

/**
 * Recursively count files whose extension matches the given set. Pass
 * `extensions = null` to count EVERY file regardless of extension (used for the
 * manual calibration folder, which has no fixed file type).
 * Skips `_frames/` subfolders (video frame uploads).
 * Caps recursion at depth 5 to prevent pathological nesting.
 */
async function countFilesRecursive(
  folderId: string,
  extensions: Set<string> | null,
  depth = 0
): Promise<FileStats> {
  if (depth > 5) return { count: 0, totalBytes: 0, newestDate: null };

  const drive = getDrive();
  let count = 0;
  let totalBytes = 0;
  let newestDate: string | null = null;
  const subfolders: { id: string; name: string }[] = [];
  let pageToken: string | undefined;

  do {
    const res = await withRetry(
      () => drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name, mimeType, size, modifiedTime)",
        pageSize: 1000,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
      `files.list(${folderId})`,
    );

    for (const file of res.data.files ?? []) {
      if (!file.id || !file.name) continue;

      if (file.mimeType === "application/vnd.google-apps.folder") {
        subfolders.push({ id: file.id, name: file.name });
      } else {
        const ext = path.extname(file.name).toLowerCase();
        if (extensions === null || extensions.has(ext)) {
          count++;
          if (file.size) totalBytes += parseInt(file.size, 10);
          if (file.modifiedTime && (!newestDate || file.modifiedTime > newestDate)) {
            newestDate = file.modifiedTime;
          }
        }
      }
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  const subStats = await Promise.all(
    subfolders
      .filter((sub) => sub.name !== "_frames")
      .map((sub) => countFilesRecursive(sub.id, extensions, depth + 1))
  );
  for (const sub of subStats) {
    count += sub.count;
    totalBytes += sub.totalBytes;
    if (sub.newestDate && (!newestDate || sub.newestDate > newestDate)) {
      newestDate = sub.newestDate;
    }
  }

  return { count, totalBytes, newestDate };
}

/**
 * Live recursive count of audio files directly under a given folder — e.g. a
 * deployment's `grabadoresDeAudio` upload subfolder (`uploadAudioFolderId`).
 *
 * NOTE: pass the AUDIO subfolder here, NOT the deployment root. `checkDeploymentUploads`
 * is the root-folder variant; calling it with the audio subfolder would look for a
 * `grabadoresDeAudio` child that doesn't exist and return 0.
 *
 * Used by the overnight batch (`audio-batch.ts`) to detect an in-progress upload
 * just before enqueuing, catching same-day uploads the nightly-cached count misses.
 */
export async function countAudioFilesInFolder(folderId: string): Promise<number> {
  const stats = await countFilesRecursive(folderId, AUDIO_EXTENSIONS);
  return stats.count;
}

export interface DriveFileInfo {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;
  modifiedTime: string | null;
}

/**
 * List files in a Drive folder that match the given extensions.
 * Returns file metadata including size and modifiedTime.
 */
export async function listFolderFiles(
  folderId: string,
  extensions: Set<string>,
  depth = 0
): Promise<DriveFileInfo[]> {
  if (depth > 5) return [];

  const drive = getDrive();
  const files: DriveFileInfo[] = [];
  const subfolders: { id: string; name: string }[] = [];
  let pageToken: string | undefined;

  do {
    const res = await withRetry(
      () => drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name, mimeType, size, modifiedTime)",
        pageSize: 1000,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
      `files.list(${folderId})`,
    );

    for (const file of res.data.files ?? []) {
      if (!file.id || !file.name) continue;

      if (file.mimeType === "application/vnd.google-apps.folder") {
        subfolders.push({ id: file.id, name: file.name });
      } else {
        const ext = path.extname(file.name).toLowerCase();
        if (extensions.has(ext)) {
          files.push({
            id: file.id,
            name: file.name,
            mimeType: file.mimeType ?? "application/octet-stream",
            size: file.size ? parseInt(file.size, 10) : null,
            modifiedTime: file.modifiedTime ?? null,
          });
        }
      }
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  const subResults = await Promise.all(
    subfolders
      .filter((sub) => sub.name !== "_frames")
      .map((sub) => listFolderFiles(sub.id, extensions, depth + 1))
  );
  for (const subFiles of subResults) {
    files.push(...subFiles);
  }

  return files;
}

/**
 * Check what data has been uploaded to a deployment's Drive folder.
 *
 * Lists subfolders of the deployment folder, then counts files in each
 * data type subfolder (camaras_trampas, grabadores_de_audio, ibutton).
 */
export async function checkDeploymentUploads(
  folderId: string
): Promise<ActionResult<UploadStatus>> {
  try {
    const drive = getDrive();

    // Verify the folder still exists and isn't trashed
    try {
      const folderMeta = await withRetry(
        () =>
          drive.files.get({
            fileId: folderId,
            fields: "id, trashed",
            supportsAllDrives: true,
          }),
        `files.get(${folderId})`,
      );
      if (folderMeta.data.trashed) {
        return { success: false, error: "Carpeta en la papelera de Drive" };
      }
    } catch {
      return { success: false, error: "Carpeta eliminada de Drive" };
    }

    // Step 1: List subfolders of the deployment folder
    log.info({ folderId }, "[Drive] Checking folder");
    const foldersRes = await withRetry(
      () =>
        drive.files.list({
          q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
          fields: "files(id, name)",
          pageSize: 20,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        }),
      `files.list(subfolders ${folderId})`,
    );

    const subfolders = foldersRes.data.files ?? [];
    log.info({ count: subfolders.length, names: subfolders.map((f) => f.name) }, "[Drive] Found subfolders");

    // Build a map of subfolder name → subfolder ID
    const subfolderMap = new Map<string, string>();
    for (const folder of subfolders) {
      if (folder.name && folder.id) {
        subfolderMap.set(folder.name, folder.id);
      }
    }

    // Step 2: Count files in each data type subfolder
    const status: UploadStatus = {
      camarasTrampas: null,
      grabadoresDeAudio: null,
      ibutton: null,
      calibracionDeAudio: null,
      camarasTrampasSizeBytes: null,
      grabadoresDeAudioSizeBytes: null,
      ibuttonSizeBytes: null,
      calibracionDeAudioSizeBytes: null,
      camarasTrampasNewestDate: null,
      grabadoresDeAudioNewestDate: null,
      ibuttonNewestDate: null,
      calibracionDeAudioNewestDate: null,
      subfolderIds: {
        camarasTrampas: subfolderMap.get(DATA_TYPE_FOLDERS.camarasTrampas) ?? null,
        grabadoresDeAudio: subfolderMap.get(DATA_TYPE_FOLDERS.grabadoresDeAudio) ?? null,
        ibutton: subfolderMap.get(DATA_TYPE_FOLDERS.ibutton) ?? null,
        calibracionDeAudio: subfolderMap.get(AUDIO_CALIBRATION_FOLDER) ?? null,
      },
    };

    const sizeKeyMap = {
      camarasTrampas: "camarasTrampasSizeBytes",
      grabadoresDeAudio: "grabadoresDeAudioSizeBytes",
      ibutton: "ibuttonSizeBytes",
    } as const;

    const dateKeyMap = {
      camarasTrampas: "camarasTrampasNewestDate",
      grabadoresDeAudio: "grabadoresDeAudioNewestDate",
      ibutton: "ibuttonNewestDate",
    } as const;

    const countPromises = Object.entries(DATA_TYPE_FOLDERS).map(
      async ([key, folderName]) => {
        const k = key as keyof typeof DATA_TYPE_FOLDERS;
        const subfolderId = subfolderMap.get(folderName);
        if (!subfolderId) {
          log.info({ folderName }, "[Drive] subfolder not found in parent");
          return { key: k, stats: { count: 0, totalBytes: 0, newestDate: null } as FileStats };
        }

        try {
          const extensions = DATA_TYPE_EXTENSIONS[k];
          const stats = await countFilesRecursive(subfolderId, extensions);
          log.info({ folderName, subfolderId, count: stats.count, sizeMb: +(stats.totalBytes / 1024 / 1024).toFixed(0) }, "[Drive] folder stats");
          return { key: k, stats };
        } catch (err) {
          log.error({ err, folderName }, "[Drive] Error counting files");
          return { key: k, stats: null };
        }
      }
    );

    const results = await Promise.allSettled(countPromises);

    for (const result of results) {
      if (result.status === "fulfilled") {
        const { key, stats } = result.value;
        status[key] = stats ? stats.count : null;
        status[sizeKeyMap[key]] = stats ? stats.totalBytes : null;
        status[dateKeyMap[key]] = stats ? stats.newestDate : null;
      }
    }

    // Audio-calibration folder — counted separately from grabadoresDeAudio and
    // NOT extension-filtered (it's a manual drop folder with no fixed file type).
    const calibrationId = subfolderMap.get(AUDIO_CALIBRATION_FOLDER);
    if (calibrationId) {
      try {
        const stats = await countFilesRecursive(calibrationId, null);
        status.calibracionDeAudio = stats.count;
        status.calibracionDeAudioSizeBytes = stats.totalBytes;
        status.calibracionDeAudioNewestDate = stats.newestDate;
      } catch (err) {
        log.error({ err, folderId }, "[Drive] Error counting calibration files");
      }
    } else {
      status.calibracionDeAudio = 0;
      status.calibracionDeAudioSizeBytes = 0;
    }

    return { success: true, data: status };
  } catch (err) {
    log.error({ err, folderId }, "[Drive] Failed to check folder");
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to check Drive folder",
    };
  }
}

// ---------------------------------------------------------------------------
// Camera Trap — Types
// ---------------------------------------------------------------------------

export interface DriveFolder {
  id: string;
  name: string;
}

export interface DriveImageFile {
  id: string;
  name: string;
  size: number;
  modifiedTime: string;
  /** Path relative to deployment root, e.g. "subfolder/IMG_001.jpg" */
  relativePath: string;
}

export interface DriveVideoFile {
  id: string;
  name: string;
  size: number;
  modifiedTime: string;
  /** Path relative to deployment root */
  relativePath: string;
}

export interface DriveMediaResult {
  images: DriveImageFile[];
  videos: DriveVideoFile[];
}

const FOLDER_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

// IMAGE/VIDEO/AUDIO/IBUTTON extension sets + DATA_TYPE_EXTENSIONS now live in
// ./drive-routing (shared with the field-upload endpoint). Imported above.

// ---------------------------------------------------------------------------
// Camera Trap — Public API
// ---------------------------------------------------------------------------

/** Validate a Drive folder ID format. */
export function isValidFolderId(folderId: string): boolean {
  return FOLDER_ID_REGEX.test(folderId);
}

/**
 * List top-level folders in a root folder (each = one deployment).
 * Uses do...while pagination with pageSize: 1000.
 */
export async function listDeploymentFolders(
  rootFolderId: string
): Promise<DriveFolder[]> {
  if (!isValidFolderId(rootFolderId)) {
    throw new Error(`Invalid folder ID format: ${rootFolderId}`);
  }

  const drive = getDrive();
  const folders: DriveFolder[] = [];
  let pageToken: string | undefined;

  do {
    const res = await withRetry(
      () => drive.files.list({
        q: `'${rootFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: "nextPageToken, files(id, name)",
        pageSize: 1000,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
      `files.list(${rootFolderId})`,
    );

    for (const file of res.data.files ?? []) {
      if (file.id && file.name) {
        folders.push({ id: file.id, name: file.name });
      }
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return folders.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Multi-drive discovery: union the deployment folders under each registered
 * Shared Drive's root. `Promise.allSettled` isolates a single drive's failure
 * (e.g. the SA lost access) so the others still return. Used when
 * SHARED_DRIVE_DISCOVERY_ENABLED is on; the single-root function above is the
 * unchanged primitive.
 */
export async function listDeploymentFoldersAcrossDrives(
  rootFolderIds: string[],
): Promise<DriveFolder[]> {
  const settled = await Promise.allSettled(
    rootFolderIds.map((root) => listDeploymentFolders(root)),
  );
  const seen = new Set<string>();
  const merged: DriveFolder[] = [];
  for (const result of settled) {
    if (result.status === "rejected") {
      log.warn({ err: result.reason }, "[Drive] Deployment-folder scan failed for one drive");
      continue;
    }
    for (const folder of result.value) {
      if (seen.has(folder.id)) continue;
      seen.add(folder.id);
      merged.push(folder);
    }
  }
  return merged.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Recursively list all image files in a folder with metadata.
 * Filters by MIME type prefix `image/`, then post-filters by supported extensions.
 * Handles pagination with do...while + nextPageToken.
 */
export async function listImagesRecursive(
  folderId: string,
  pathPrefix = ""
): Promise<DriveImageFile[]> {
  const result = await listMediaRecursive(folderId, pathPrefix);
  return result.images;
}

/**
 * Recursively list all media files (images + videos) in a folder.
 * Filters by MIME type prefix, then post-filters by supported extensions.
 * Handles pagination with do...while + nextPageToken.
 */
export async function listMediaRecursive(
  folderId: string,
  pathPrefix = ""
): Promise<DriveMediaResult> {
  if (!isValidFolderId(folderId)) {
    throw new Error(`Invalid folder ID format: ${folderId}`);
  }

  const drive = getDrive();
  const imageFiles: DriveImageFile[] = [];
  const videoFiles: DriveVideoFile[] = [];
  const subfolders: { id: string; name: string }[] = [];

  // List all files and subfolders in this folder
  let pageToken: string | undefined;
  do {
    const res = await withRetry(
      () => drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name, mimeType, size, modifiedTime)",
        pageSize: 1000,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
      `files.list(${folderId})`,
    );

    for (const file of res.data.files ?? []) {
      if (!file.id || !file.name) continue;

      const relativePath = pathPrefix
        ? `${pathPrefix}/${file.name}`
        : file.name;

      if (file.mimeType === "application/vnd.google-apps.folder") {
        subfolders.push({ id: file.id, name: file.name });
      } else if (file.mimeType?.startsWith("image/")) {
        const ext = path.extname(file.name).toLowerCase();
        if (IMAGE_EXTENSIONS.has(ext)) {
          imageFiles.push({
            id: file.id,
            name: file.name,
            size: parseInt(file.size || "0", 10),
            modifiedTime: file.modifiedTime || "",
            relativePath,
          });
        }
      } else if (file.mimeType?.startsWith("video/")) {
        const ext = path.extname(file.name).toLowerCase();
        if (VIDEO_EXTENSIONS.has(ext)) {
          videoFiles.push({
            id: file.id,
            name: file.name,
            size: parseInt(file.size || "0", 10),
            modifiedTime: file.modifiedTime || "",
            relativePath,
          });
        }
      }
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  // Recurse into subfolders (skip _frames/ — our uploaded video frames)
  const subResults = await Promise.all(
    subfolders
      .filter((sub) => sub.name !== "_frames")
      .map((sub) => {
        const subPath = pathPrefix ? `${pathPrefix}/${sub.name}` : sub.name;
        return listMediaRecursive(sub.id, subPath);
      })
  );
  for (const subResult of subResults) {
    imageFiles.push(...subResult.images);
    videoFiles.push(...subResult.videos);
  }

  return { images: imageFiles, videos: videoFiles };
}

/**
 * Get the name of a Drive file's parent folder.
 * Useful for extracting date-based folder names (e.g. "2026-02-25").
 */
export async function getDriveFileParentName(
  fileId: string,
): Promise<string | null> {
  const drive = getDrive();
  const fileMeta = await drive.files.get({
    fileId,
    fields: "parents",
    supportsAllDrives: true,
  });
  const parentId = fileMeta.data.parents?.[0];
  if (!parentId) return null;

  const parentMeta = await drive.files.get({
    fileId: parentId,
    fields: "name",
    supportsAllDrives: true,
  });
  return parentMeta.data.name ?? null;
}

/**
 * Download a single file from Drive to a local path.
 * Retries once on failure.
 */
export async function downloadFile(
  fileId: string,
  destPath: string
): Promise<void> {
  await withRetry(async () => {
    const drive = getDrive();
    const res = await drive.files.get(
      { fileId, alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" },
    );

    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, Buffer.from(res.data as ArrayBuffer));
  }, `downloadFile(${fileId})`);
}

/**
 * Download all images in a deployment folder to a local directory.
 * Uses batches of 10 with Promise.all. Retries once per file; skips on second failure.
 */
export async function downloadDeploymentImages(
  imageFiles: DriveImageFile[],
  destDir: string,
  onProgress?: (downloaded: number, failed: number, total: number) => void,
  isCancelled?: () => Promise<boolean>,
): Promise<{ downloaded: number; failed: number; pathMap: Map<string, string> }> {
  let downloaded = 0;
  let failed = 0;
  const pathMap = new Map<string, string>(); // driveFileId → local path

  const BATCH_SIZE = 50;
  const totalBatches = Math.ceil(imageFiles.length / BATCH_SIZE);
  const startTime = Date.now();

  for (let i = 0; i < imageFiles.length; i += BATCH_SIZE) {
    // Check for cancellation between batches
    if (isCancelled && await isCancelled()) {
      log.info({ downloaded }, "[Drive] Download cancelled");
      break;
    }

    const batchStart = Date.now();
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const batch = imageFiles.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async (file) => {
        const localPath = path.join(destDir, file.relativePath);
        try {
          await downloadFile(file.id, localPath);
          pathMap.set(file.id, localPath);
          downloaded++;
        } catch (err) {
          log.error({ err, fileName: file.name, fileId: file.id }, "[Drive] Failed to download file");
          failed++;
        }
      })
    );

    const batchSec = ((Date.now() - batchStart) / 1000).toFixed(1);
    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    const mem = process.memoryUsage();
    const rssMB = (mem.rss / 1024 / 1024).toFixed(0);
    log.info(
      { batchNum, totalBatches, downloaded, failed, batchSec, elapsedSec, rssMB },
      "[Drive] Batch complete"
    );

    onProgress?.(downloaded, failed, imageFiles.length);
  }

  return { downloaded, failed, pathMap };
}

/**
 * Download a single file's content to a Buffer (for image proxy serving).
 */
export async function downloadFileToBuffer(
  fileId: string
): Promise<Buffer> {
  return withRetry(async () => {
    const drive = getDrive();
    const res = await drive.files.get(
      { fileId, alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" },
    );
    return Buffer.from(res.data as ArrayBuffer);
  }, `downloadFileToBuffer(${fileId})`);
}

/**
 * Stream a file from Drive without buffering the entire file in memory.
 * Supports Range headers for seeking (used by audio/video players).
 */
export async function downloadFileAsStream(
  fileId: string,
  rangeHeader?: string
): Promise<{
  stream: Readable;
  contentType: string;
  contentLength: number | undefined;
  contentRange: string | undefined;
  status: number;
}> {
  const drive = getDrive();
  const headers: Record<string, string> = {};
  if (rangeHeader) headers["Range"] = rangeHeader;

  const res = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "stream", headers }
  );

  return {
    stream: res.data as unknown as Readable,
    contentType:
      (res.headers["content-type"] as string) ?? "application/octet-stream",
    contentLength: res.headers["content-length"]
      ? parseInt(res.headers["content-length"] as string)
      : undefined,
    contentRange: (res.headers["content-range"] as string) ?? undefined,
    status: res.status,
  };
}

// ---------------------------------------------------------------------------
// Create Deployment Folder (with subfolders)
// ---------------------------------------------------------------------------

export interface CreatedFolder {
  id: string;
  name: string;
  webViewLink: string;
  subfolderIds: {
    camarasTrampas: string | null;
    grabadoresDeAudio: string | null;
    ibutton: string | null;
    calibracionDeAudio: string | null;
  };
}

/**
 * Ensure a single named subfolder exists directly under a parent folder,
 * returning its id (reusing an existing one if present). Idempotent. Used for
 * the calibration folder backfill across already-created deployment folders.
 */
export async function ensureDeploymentSubfolder(
  parentFolderId: string,
  name: string,
): Promise<string | null> {
  const drive = getDrive();
  const FOLDER_MIME = "application/vnd.google-apps.folder";

  const existing = await withRetry(
    () =>
      drive.files.list({
        q: `'${parentFolderId}' in parents and name = '${name.replace(/'/g, "\\'")}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
        fields: "files(id)",
        pageSize: 1,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
    `files.list(subfolder ${name} in ${parentFolderId})`,
  );
  const existingId = existing.data.files?.[0]?.id;
  if (existingId) return existingId;

  const created = await withRetry(
    () =>
      drive.files.create({
        requestBody: { name, mimeType: FOLDER_MIME, parents: [parentFolderId] },
        fields: "id",
        supportsAllDrives: true,
      }),
    `files.create(subfolder ${name} in ${parentFolderId})`,
  );
  return created.data.id ?? null;
}

/**
 * Create a deployment folder under a parent, plus the 3 data-type subfolders.
 * If a folder with the same name already exists, reuses it.
 * All API calls include supportsAllDrives for Shared Drive compatibility.
 */
export async function createDeploymentFolder(
  parentFolderId: string,
  deploymentName: string
): Promise<CreatedFolder> {
  if (!isValidFolderId(parentFolderId)) {
    throw new Error(`Invalid parent folder ID: ${parentFolderId}`);
  }

  const drive = getDrive();
  const FOLDER_MIME = "application/vnd.google-apps.folder";

  // Check if folder already exists under parent
  const existingRes = await drive.files.list({
    q: `'${parentFolderId}' in parents and name = '${deploymentName.replace(/'/g, "\\'")}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
    fields: "files(id, name, webViewLink)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  let folderId: string;
  let webViewLink: string;

  const existing = existingRes.data.files?.[0];
  if (existing?.id) {
    log.info({ deploymentName, folderId: existing.id }, "[Drive] Reusing existing folder");
    folderId = existing.id;
    webViewLink = existing.webViewLink ?? `https://drive.google.com/drive/folders/${folderId}`;
  } else {
    // Create the deployment folder
    const createRes = await drive.files.create({
      requestBody: {
        name: deploymentName,
        mimeType: FOLDER_MIME,
        parents: [parentFolderId],
      },
      fields: "id, name, webViewLink",
      supportsAllDrives: true,
    });

    folderId = createRes.data.id!;
    webViewLink = createRes.data.webViewLink ?? `https://drive.google.com/drive/folders/${folderId}`;
    log.info({ deploymentName, folderId }, "[Drive] Created folder");
  }

  // List existing subfolders to avoid duplicates
  const subfoldersRes = await drive.files.list({
    q: `'${folderId}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
    fields: "files(id, name)",
    pageSize: 20,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const existingSubfolderMap = new Map(
    (subfoldersRes.data.files ?? [])
      .filter((f): f is { id: string; name: string } => !!f.id && !!f.name)
      .map((f) => [f.name, f.id])
  );

  // Create missing subfolders, tracking IDs for all. The calibration folder is
  // created alongside the three routable data-type folders but kept under its
  // own key (it is intentionally NOT part of DATA_TYPE_FOLDERS — see drive-routing).
  const subfolderIdMap = new Map<string, string>();
  const subfoldersToCreate: [string, string][] = [
    ...Object.entries(DATA_TYPE_FOLDERS),
    ["calibracionDeAudio", AUDIO_CALIBRATION_FOLDER],
  ];
  for (const [key, subName] of subfoldersToCreate) {
    const existingId = existingSubfolderMap.get(subName);
    if (existingId) {
      log.info({ subName }, "[Drive] Subfolder already exists");
      subfolderIdMap.set(key, existingId);
      continue;
    }

    const res = await drive.files.create({
      requestBody: {
        name: subName,
        mimeType: FOLDER_MIME,
        parents: [folderId],
      },
      fields: "id",
      supportsAllDrives: true,
    });
    if (res.data.id) {
      subfolderIdMap.set(key, res.data.id);
    }
    log.info({ subName }, "[Drive] Created subfolder");
  }

  return {
    id: folderId,
    name: deploymentName,
    webViewLink,
    subfolderIds: {
      camarasTrampas: subfolderIdMap.get("camarasTrampas") ?? null,
      grabadoresDeAudio: subfolderIdMap.get("grabadoresDeAudio") ?? null,
      ibutton: subfolderIdMap.get("ibutton") ?? null,
      calibracionDeAudio: subfolderIdMap.get("calibracionDeAudio") ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Upload Video Frames to Drive
// ---------------------------------------------------------------------------

const FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * Find or create a subfolder by name under a parent folder.
 * Reuses existing folder if found. All calls include supportsAllDrives.
 */
async function findOrCreateSubfolder(
  parentId: string,
  name: string
): Promise<string> {
  const drive = getDrive();

  const existing = await drive.files.list({
    q: `'${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
    fields: "files(id)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  if (existing.data.files?.[0]?.id) {
    return existing.data.files[0].id;
  }

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: FOLDER_MIME,
      parents: [parentId],
    },
    fields: "id",
    supportsAllDrives: true,
  });

  log.info({ name, parentId }, "[Drive] Created subfolder in parent");
  return created.data.id!;
}

/**
 * Upload a single file to Drive, returning its file ID.
 */
async function uploadSingleFile(
  parentId: string,
  localPath: string,
  filename: string
): Promise<string> {
  const drive = getDrive();

  const res = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [parentId],
    },
    media: {
      mimeType: "image/jpeg",
      body: createReadStream(localPath),
    },
    fields: "id",
    supportsAllDrives: true,
  });

  return res.data.id!;
}

/**
 * Look up an existing subfolder by name under a parent folder. Returns the
 * folder ID if found, or null. Used to nest the `_frames/` upload under a
 * `camaras_trampas/` subfolder when one exists, so frames live next to the
 * source videos rather than at the deployment root.
 */
async function findSubfolderId(
  parentId: string,
  name: string,
): Promise<string | null> {
  const drive = getDrive();
  const res = await drive.files.list({
    q: `'${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
    fields: "files(id)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files?.[0]?.id ?? null;
}

/**
 * Upload extracted video frames to a `_frames/` subfolder. If the deployment
 * has a `camaras_trampas/` subfolder (the FCAT convention for camera-trap
 * media inside a multi-sensor deployment), the `_frames/` folder is nested
 * inside it so the frames live next to the source videos. Otherwise the
 * `_frames/` folder is created at the deployment root.
 *
 * Returns a map of filename → driveFileId. Uploads in batches to avoid
 * overwhelming the API.
 */
export async function uploadFramesToDrive(
  deploymentFolderId: string,
  frames: { localPath: string; filename: string }[],
  onProgress?: (uploaded: number, total: number) => Promise<void>
): Promise<Map<string, string>> {
  // Prefer nesting under camaras_trampas/ when present.
  const cameraTrapFolderId = await findSubfolderId(
    deploymentFolderId,
    "camaras_trampas",
  );
  const framesParentId = cameraTrapFolderId ?? deploymentFolderId;
  const framesFolderId = await findOrCreateSubfolder(framesParentId, "_frames");
  const result = new Map<string, string>();
  const BATCH_SIZE = 20;

  for (let i = 0; i < frames.length; i += BATCH_SIZE) {
    const batch = frames.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async (frame) => {
        try {
          const driveFileId = await uploadSingleFile(
            framesFolderId,
            frame.localPath,
            frame.filename
          );
          result.set(frame.filename, driveFileId);
        } catch (err) {
          log.error(
            { err, filename: frame.filename },
            "[Drive] Failed to upload frame"
          );
        }
      })
    );

    if (onProgress) {
      await onProgress(Math.min(i + BATCH_SIZE, frames.length), frames.length);
    }
  }

  log.info({ uploaded: result.size, total: frames.length }, "[Drive] Uploaded frames to _frames/");
  return result;
}

// ---------------------------------------------------------------------------
// Retry Helper (shared by update, revision, and trash operations)
// ---------------------------------------------------------------------------

const MAX_RETRIES = 4;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 16_000;

interface DriveError {
  code?: number;
  status?: number;
  message?: string;
  response?: { status?: number; data?: { error?: { errors?: Array<{ reason?: string }> } } };
  errors?: Array<{ reason?: string }>;
  cause?: { message?: string; errors?: Array<{ reason?: string }> };
}

export function isRetriableDriveError(err: unknown): boolean {
  const e = err as DriveError;
  const status = e?.code ?? e?.status ?? e?.response?.status;
  if (status === 429) return true;
  if (status != null && status >= 500 && status < 600) return true;
  if (status === 403) {
    // gaxios nests the Google `reason` differently across versions (v7 moved it
    // off the top-level `errors`), so probe every known location and fall back
    // to the human-readable message. Missing this silently disables retries for
    // rate-limit 403s — the exact failure that breaks a full-drive count.
    const reason =
      e?.errors?.[0]?.reason ??
      e?.cause?.errors?.[0]?.reason ??
      e?.response?.data?.error?.errors?.[0]?.reason;
    if (reason === "userRateLimitExceeded" || reason === "rateLimitExceeded") {
      return true;
    }
    const msg = String(e?.message ?? e?.cause?.message ?? "");
    return /rate limit/i.test(msg);
  }
  return false;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetriableDriveError(err) || attempt === MAX_RETRIES) {
        throw err;
      }
      const exp = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
      const delay = Math.floor(exp / 2 + Math.random() * (exp / 2));
      log.warn({ label, delay, attempt: attempt + 1 }, "[Drive] Retrying transient error");
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// File Revision Helpers (for compression undo)
// ---------------------------------------------------------------------------

export interface DriveRevision {
  id: string;
  modifiedTime: string | null;
  size: number | null;
}

/**
 * List all revisions for a file, sorted oldest-first.
 * Used to find the pre-compression original.
 */
export async function getFileRevisions(fileId: string): Promise<DriveRevision[]> {
  const drive = getDrive();

  const res = await withRetry(
    () =>
      drive.revisions.list({
        fileId,
        fields: "revisions(id, modifiedTime, size)",
      }),
    `getFileRevisions(${fileId})`,
  );

  return (res.data.revisions ?? []).map((r) => ({
    id: r.id!,
    modifiedTime: r.modifiedTime ?? null,
    size: r.size ? parseInt(r.size, 10) : null,
  }));
}

/**
 * Download a specific revision of a file as a Buffer.
 * Used to restore the pre-compression original.
 */
export async function downloadFileRevision(
  fileId: string,
  revisionId: string,
): Promise<Buffer> {
  const drive = getDrive();

  const res = await withRetry(
    () =>
      drive.revisions.get(
        { fileId, revisionId, alt: "media" },
        { responseType: "arraybuffer" },
      ),
    `downloadFileRevision(${fileId}, ${revisionId})`,
  );

  return Buffer.from(res.data as ArrayBuffer);
}

// ---------------------------------------------------------------------------
// Update / Delete File Operations
// ---------------------------------------------------------------------------

/**
 * Replace the content of an existing file on Drive.
 * Used for image compression — uploads new content while keeping the same file ID.
 */
export async function updateFileContent(
  fileId: string,
  buffer: Buffer,
  mimeType: string,
  modifiedTime?: Date | string | null,
): Promise<void> {
  const drive = getDrive();

  // Preserve the caller-supplied modifiedTime instead of letting Drive stamp
  // "now" on a content rewrite. Occupancy's capture-day fallback reads
  // biochoco_images.file_modified (Drive's modifiedTime captured at scan); a
  // compression re-upload that bumped it to the compression date silently
  // shifted a deployment's survey window (GIZ-004 → June). When omitted, Drive
  // keeps its default behavior.
  const iso =
    modifiedTime == null
      ? null
      : modifiedTime instanceof Date
        ? modifiedTime.toISOString()
        : modifiedTime;

  await withRetry(
    () =>
      drive.files.update({
        fileId,
        ...(iso ? { requestBody: { modifiedTime: iso } } : {}),
        media: {
          mimeType,
          body: Readable.from(buffer),
        },
        supportsAllDrives: true,
      }),
    `updateFileContent(${fileId})`,
  );
}

// ---------------------------------------------------------------------------
// Drive write rate cap (used for audio compression bulk-rewrites)
// ---------------------------------------------------------------------------
// Drive's per-user write quota is 1000 requests / 100 s = 10 req/s sustained.
// A 200ms floor (~5 req/s sustained, with burst tolerance via Promise.all)
// leaves headroom under the quota. `withRetry` (below) handles transient 429s
// with exponential backoff, so accidental bursts are safe.
// Best-effort process-local — survives if the process is the only writer;
// reset on container restart.

const DRIVE_WRITE_MIN_INTERVAL_MS = 200;
let lastDriveWriteMs = 0;

async function waitForDriveWriteSlot(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastDriveWriteMs;
  if (elapsed < DRIVE_WRITE_MIN_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, DRIVE_WRITE_MIN_INTERVAL_MS - elapsed));
  }
  lastDriveWriteMs = Date.now();
}

/**
 * Atomically replace a file's content AND filename in one Drive call.
 * Used for the audio compression workflow: WAV bytes + name → FLAC bytes + name,
 * preserving the file ID. The pre-replacement revision id and the post-replacement
 * file size are returned so callers can pin the revision and update DB rows.
 *
 * Filename sanitization: `newName` must be a basename — no path separators, no
 * `..` segments. This closes a pre-existing path-traversal surface in
 * audio-cache.ts where Drive names flow back into local FS paths.
 */
export async function replaceFileContentAndRename(
  fileId: string,
  buffer: Buffer,
  newName: string,
  mimeType: string,
): Promise<{ headRevisionId: string | null; size: number | null }> {
  if (!newName || newName !== path.basename(newName) || newName.includes("..")) {
    throw new Error(`Refusing unsafe Drive filename: ${JSON.stringify(newName)}`);
  }

  await waitForDriveWriteSlot();
  const drive = getDrive();
  const res = await withRetry(
    () =>
      drive.files.update({
        fileId,
        requestBody: { name: newName, mimeType },
        media: { mimeType, body: Readable.from(buffer) },
        fields: "id,name,mimeType,headRevisionId,size",
        supportsAllDrives: true,
      }),
    `replaceFileContentAndRename(${fileId})`,
  );
  return {
    headRevisionId: res.data.headRevisionId ?? null,
    size: res.data.size ? parseInt(res.data.size, 10) : null,
  };
}

/**
 * Pin a specific revision with `keepForever=true` so Drive never garbage-collects
 * it beyond the 30-day default window. Used during the first 90 days of the
 * audio compression rollout to keep pre-replace WAVs revertible.
 *
 * Non-fatal at the call site — caller logs failure and continues.
 */
export async function pinFileRevision(
  fileId: string,
  revisionId: string,
): Promise<void> {
  const drive = getDrive();
  await withRetry(
    () =>
      drive.revisions.update({
        fileId,
        revisionId,
        requestBody: { keepForever: true },
      }),
    `pinFileRevision(${fileId}, ${revisionId})`,
  );
}

/**
 * Fetch the metadata needed by the audio compression reconciliation pre-check:
 * the current filename, MIME type, head revision id, and size. Returns null if
 * the file no longer exists on Drive (treat as "skip this file").
 */
export async function getFileMetadataWithRevision(
  fileId: string,
): Promise<
  | {
      name: string;
      mimeType: string;
      headRevisionId: string | null;
      size: number | null;
    }
  | null
> {
  const drive = getDrive();
  try {
    const res = await withRetry(
      () =>
        drive.files.get({
          fileId,
          fields: "id,name,mimeType,headRevisionId,size,trashed",
          supportsAllDrives: true,
        }),
      `getFileMetadataWithRevision(${fileId})`,
    );
    if (res.data.trashed) return null;
    return {
      name: res.data.name ?? "",
      mimeType: res.data.mimeType ?? "application/octet-stream",
      headRevisionId: res.data.headRevisionId ?? null,
      size: res.data.size ? parseInt(res.data.size, 10) : null,
    };
  } catch (err) {
    const status = (err as { code?: number; status?: number })?.code
      ?? (err as { code?: number; status?: number })?.status;
    if (status === 404) return null;
    throw err;
  }
}

/**
 * Soft-delete a file to Drive trash (recoverable for 30 days).
 * Used for blank image deletion — safer than permanent delete.
 */
export async function trashFile(fileId: string): Promise<void> {
  const drive = getDrive();

  await withRetry(
    () =>
      drive.files.update({
        fileId,
        requestBody: { trashed: true },
        supportsAllDrives: true,
      }),
    `trashFile(${fileId})`,
  );
}

// ---------------------------------------------------------------------------
// Researcher Applications — file upload & folder management
// ---------------------------------------------------------------------------

export interface UploadedFileInfo {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  category?: string;
}

/**
 * Get or create an application subfolder under the research applications
 * root folder. Returns the subfolder ID.
 */
export async function getOrCreateApplicationFolder(
  referenceCode: string
): Promise<string> {
  const rootFolderId = process.env.RESEARCH_APPLICATIONS_DRIVE_FOLDER_ID;
  if (!rootFolderId) {
    throw new Error("RESEARCH_APPLICATIONS_DRIVE_FOLDER_ID not configured");
  }
  return findOrCreateSubfolder(rootFolderId, referenceCode);
}

/**
 * Rename a Drive folder or file.
 */
export async function renameDriveFile(
  fileId: string,
  newName: string
): Promise<void> {
  const drive = getDrive();
  await withRetry(
    () =>
      drive.files.update({
        fileId,
        requestBody: { name: newName },
        supportsAllDrives: true,
      }),
    `renameDriveFile(${fileId})`,
  );
}

/**
 * Upload a file buffer to a Shared Drive folder. Returns file metadata.
 */
export async function uploadFileToSharedDrive(
  buffer: Buffer,
  filename: string,
  mimeType: string,
  parentFolderId: string
): Promise<UploadedFileInfo> {
  const drive = getDrive();

  const res = await withRetry(
    () =>
      drive.files.create({
        requestBody: {
          name: filename,
          parents: [parentFolderId],
        },
        media: {
          mimeType,
          body: Readable.from(buffer),
        },
        fields: "id,name,mimeType,size",
        supportsAllDrives: true,
      }),
    `uploadFileToSharedDrive(${filename})`,
  );

  return {
    id: res.data.id!,
    name: res.data.name!,
    mimeType: res.data.mimeType!,
    size: Number(res.data.size ?? 0),
  };
}

/**
 * Upload a file from a LOCAL PATH to a Shared Drive folder, streaming from
 * disk (so multi-GB archives never buffer in memory) and returning a
 * shareable webViewLink. Mirrors uploadFileToSharedDrive but reads via
 * createReadStream and requests the link field. The uploaded file inherits
 * the destination Shared Drive's membership — there is no "anyone with link"
 * sharing here.
 */
export async function uploadLocalFileToSharedDrive(
  localPath: string,
  filename: string,
  mimeType: string,
  parentFolderId: string
): Promise<{ id: string; webViewLink: string; size: number }> {
  const drive = getDrive();

  const res = await withRetry(
    () =>
      drive.files.create({
        requestBody: {
          name: filename,
          parents: [parentFolderId],
        },
        media: {
          mimeType,
          body: createReadStream(localPath),
        },
        fields: "id,name,size,webViewLink",
        supportsAllDrives: true,
      }),
    `uploadLocalFileToSharedDrive(${filename})`,
  );

  return {
    id: res.data.id!,
    webViewLink:
      res.data.webViewLink ??
      `https://drive.google.com/file/d/${res.data.id}/view`,
    size: Number(res.data.size ?? 0),
  };
}

/**
 * Delete a file from Drive permanently. Used for cleanup on partial upload failure.
 */
export async function deleteDriveFile(fileId: string): Promise<void> {
  const drive = getDrive();

  await withRetry(
    () =>
      drive.files.delete({
        fileId,
        supportsAllDrives: true,
      }),
    `deleteDriveFile(${fileId})`,
  );
}

/**
 * Get file metadata from Drive (name, mimeType). Used for proxy downloads.
 */
export async function getFileMetadata(
  fileId: string
): Promise<{ name: string; mimeType: string }> {
  const drive = getDrive();

  const meta = await withRetry(
    () =>
      drive.files.get({
        fileId,
        fields: "name,mimeType",
        supportsAllDrives: true,
      }),
    `getFileMetadata(${fileId})`,
  );

  return {
    mimeType: meta.data.mimeType ?? "application/octet-stream",
    name: meta.data.name ?? "download",
  };
}

// ---------------------------------------------------------------------------
// Shared Drive capacity helpers (multi-drive fan-out reconciliation)
//
// These operate at the *drive* level (driveId, the 0A… Shared Drive ID), not
// the folder level. `drives.get` does NOT expose an item count (Drive API v3),
// so capacity is measured by a full `files.list?driveId` count (weekly /
// bootstrap) trued up nightly by a `changes.list?driveId` delta.
// ---------------------------------------------------------------------------

export interface SharedDriveMetadata {
  name: string;
  createdTime: string | null;
}

/**
 * Fetch Shared Drive metadata. Used to (1) confirm a drive ID at registration
 * and (2) health-check access during reconcile. Throws on 403/404/5xx (the
 * caller maps that to status='unreachable').
 */
export async function getSharedDriveMetadata(
  driveId: string,
): Promise<SharedDriveMetadata> {
  const drive = getDrive();
  const res = await withRetry(
    () =>
      drive.drives.get({
        driveId,
        fields: "name,createdTime",
      }),
    `drives.get(${driveId})`,
  );
  return {
    name: res.data.name ?? "(sin nombre)",
    createdTime: res.data.createdTime ?? null,
  };
}

export interface SharedDriveItemCount {
  /** Every item that counts toward Google's 500K cap (incl. trashed). */
  total: number;
  /** Subset of `total` currently in Trash — purgeable to reclaim capacity. */
  trashed: number;
}

/**
 * Full paginated item count of a Shared Drive. Counts EVERYTHING that counts
 * toward Google's 500,000-item cap: files + folders + items still in Trash
 * (trashed items keep counting until Google purges them ~30 days later). We do
 * NOT filter `trashed = false` here — that under-counted vs Google's own item
 * cap, so the portal showed a lower % than the Drive UI warning. `trashed` is
 * returned separately so the admin UI can show how much is reclaimable.
 *
 * Used for the weekly full reconcile and the at-registration baseline. ~500
 * calls at 500K items, so callers should bound concurrency (p-limit).
 */
export async function countSharedDriveItems(
  driveId: string,
): Promise<SharedDriveItemCount> {
  const drive = getDrive();
  let total = 0;
  let trashed = 0;
  let pageToken: string | undefined;
  do {
    const res = await withRetry(
      () =>
        drive.files.list({
          corpora: "drive",
          driveId,
          // No `trashed` filter: Drive v3 returns trashed items too, which is
          // what we want — they count toward the cap until purged.
          fields: "nextPageToken, files(id, trashed)",
          pageSize: 1000,
          pageToken,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        }),
      `files.list(count ${driveId})`,
    );
    for (const f of res.data.files ?? []) {
      total += 1;
      if (f.trashed === true) trashed += 1;
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return { total, trashed };
}

/** Opaque cursor for a Shared Drive's change feed (tokens never expire). */
export async function getChangesStartPageToken(
  driveId: string,
): Promise<string> {
  const drive = getDrive();
  const res = await withRetry(
    () =>
      drive.changes.getStartPageToken({
        driveId,
        supportsAllDrives: true,
      }),
    `changes.getStartPageToken(${driveId})`,
  );
  if (!res.data.startPageToken) {
    throw new Error("Drive API returned no startPageToken");
  }
  return res.data.startPageToken;
}

export interface SharedDriveChangesDelta {
  /** net item delta = creates − permanent removals since the token. */
  delta: number;
  /** cursor to persist for the next delta run. */
  newStartPageToken: string;
}

/**
 * Paginate the change feed from `pageToken`, accumulating a net item delta that
 * mirrors Google's item-cap accounting:
 *   - `removed` (permanently deleted / purged) → −1 (no longer counts)
 *   - `trashed` → 0 (still counts toward the cap until purged; already counted
 *     at creation, so a trash event is net-zero)
 *   - a present file *created* in this window (`createdTime > since`) → +1
 *   - any other present file (plain modification, move, rename, or a drive-wide
 *     permission/membership change that re-emits a change per file) → 0
 *
 * The `createdTime` gate is what stops phantom inflation: Google's change feed
 * emits an entry for ANY mutation, so a single member/permission change on the
 * drive re-surfaces every file and the old "+1 per present file" heuristic
 * counted hundreds of thousands of already-counted items as new (the FCAT-
 * BIOCHOCO 817K spike, 2026-06-27). Comparing each file's creation time against
 * the last reconcile boundary counts only genuinely new items.
 *
 * `since` is the start of this delta's window (the previous reconcile time). If
 * null/unparseable we fall back to the legacy "+1 per present file" behavior so
 * we never silently undercount — the weekly full count corrects any drift.
 * Trash is NOT treated as a removal here (that under-counted vs Google).
 * Per-drive `trashed_count` is refreshed only on the weekly full count.
 */
export async function listSharedDriveChangesDelta(
  driveId: string,
  pageToken: string,
  since: string | null,
): Promise<SharedDriveChangesDelta> {
  const drive = getDrive();
  let delta = 0;
  let token: string | undefined = pageToken;
  let newStartPageToken = pageToken;

  // SQLite `datetime('now')` is space-separated UTC (e.g. "2026-06-27 08:01:04");
  // Drive `createdTime` is RFC3339 (e.g. "2026-06-27T08:01:04.000Z"). Normalize
  // the former to ISO so both parse to the same UTC instant.
  const sinceMs = since ? Date.parse(since.replace(" ", "T") + "Z") : NaN;
  const haveSince = Number.isFinite(sinceMs);

  do {
    const res = await withRetry(
      () =>
        drive.changes.list({
          driveId,
          pageToken: token,
          includeRemoved: true,
          pageSize: 1000,
          fields:
            "nextPageToken, newStartPageToken, changes(removed, file(id, trashed, mimeType, createdTime))",
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        }),
      `changes.list(${driveId})`,
    );

    for (const change of res.data.changes ?? []) {
      const removed = change.removed === true;
      const trashed = change.file?.trashed === true;
      if (removed) {
        delta -= 1; // permanently purged — no longer counts toward the cap
      } else if (trashed) {
        // Still counts until purged; already counted at creation → net zero.
      } else if (change.file?.id) {
        if (!haveSince) {
          // Legacy fallback: no reconcile boundary to compare against.
          delta += 1;
        } else {
          const createdMs = change.file.createdTime
            ? Date.parse(change.file.createdTime)
            : NaN;
          // Count only files created within this delta window. A modification,
          // move, or drive-wide permission change leaves createdTime <= since.
          if (Number.isFinite(createdMs) && createdMs > sinceMs) {
            delta += 1;
          }
        }
      }
    }

    if (res.data.newStartPageToken) {
      newStartPageToken = res.data.newStartPageToken;
    }
    token = res.data.nextPageToken ?? undefined;
  } while (token);

  return { delta, newStartPageToken };
}
