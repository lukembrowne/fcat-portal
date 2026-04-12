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

// --- Types ---

export interface UploadStatus {
  camarasTrampas: number | null; // file count, null = subfolder not found or check failed
  grabadoresDeAudio: number | null;
  ibutton: number | null;
  camarasTrampasSizeBytes: number | null;
  grabadoresDeAudioSizeBytes: number | null;
  ibuttonSizeBytes: number | null;
  camarasTrampasNewestDate: string | null;
  grabadoresDeAudioNewestDate: string | null;
  ibuttonNewestDate: string | null;
  subfolderIds: {
    camarasTrampas: string | null;
    grabadoresDeAudio: string | null;
    ibutton: string | null;
  };
}

interface FileStats {
  count: number;
  totalBytes: number;
  newestDate: string | null;
}

// Subfolder names on Google Drive (must match exactly)
const DATA_TYPE_FOLDERS = {
  camarasTrampas: "camaras_trampas",
  grabadoresDeAudio: "grabadores_de_audio",
  ibutton: "ibutton",
} as const;

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
 * Recursively count files whose extension matches the given set.
 * Skips `_frames/` subfolders (video frame uploads).
 * Caps recursion at depth 5 to prevent pathological nesting.
 */
async function countFilesRecursive(
  folderId: string,
  extensions: Set<string>,
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
        if (extensions.has(ext)) {
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
      const folderMeta = await drive.files.get({
        fileId: folderId,
        fields: "id, trashed",
        supportsAllDrives: true,
      });
      if (folderMeta.data.trashed) {
        return { success: false, error: "Carpeta en la papelera de Drive" };
      }
    } catch {
      return { success: false, error: "Carpeta eliminada de Drive" };
    }

    // Step 1: List subfolders of the deployment folder
    log.info({ folderId }, "[Drive] Checking folder");
    const foldersRes = await drive.files.list({
      q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "files(id, name)",
      pageSize: 20,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

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
      camarasTrampasSizeBytes: null,
      grabadoresDeAudioSizeBytes: null,
      ibuttonSizeBytes: null,
      camarasTrampasNewestDate: null,
      grabadoresDeAudioNewestDate: null,
      ibuttonNewestDate: null,
      subfolderIds: {
        camarasTrampas: subfolderMap.get(DATA_TYPE_FOLDERS.camarasTrampas) ?? null,
        grabadoresDeAudio: subfolderMap.get(DATA_TYPE_FOLDERS.grabadoresDeAudio) ?? null,
        ibutton: subfolderMap.get(DATA_TYPE_FOLDERS.ibutton) ?? null,
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

const IMAGE_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff", ".tif",
]);

const VIDEO_EXTENSIONS = new Set([".mp4", ".avi", ".mov"]);

export const AUDIO_EXTENSIONS = new Set([
  ".wav", ".mp3", ".flac", ".wac", ".w4v", ".ogg", ".aac",
]);

const IBUTTON_EXTENSIONS = new Set([".xlsx"]);

const DATA_TYPE_EXTENSIONS: Record<keyof typeof DATA_TYPE_FOLDERS, Set<string>> = {
  camarasTrampas: new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]),
  grabadoresDeAudio: AUDIO_EXTENSIONS,
  ibutton: IBUTTON_EXTENSIONS,
};

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
  };
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

  // Create missing subfolders, tracking IDs for all
  const subfolderIdMap = new Map<string, string>();
  for (const [key, subName] of Object.entries(DATA_TYPE_FOLDERS)) {
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

const RATE_LIMIT_DELAYS = [1000, 2000, 4000];

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
): Promise<T> {
  for (let attempt = 0; attempt <= RATE_LIMIT_DELAYS.length; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const status = (err as { code?: number })?.code;
      if ((status === 429 || status === 403) && attempt < RATE_LIMIT_DELAYS.length) {
        const delay = RATE_LIMIT_DELAYS[attempt];
        log.warn({ label, delay, attempt: attempt + 1 }, "[Drive] Rate limited, retrying");
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Unreachable");
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
): Promise<void> {
  const drive = getDrive();

  await withRetry(
    () =>
      drive.files.update({
        fileId,
        media: {
          mimeType,
          body: Readable.from(buffer),
        },
        supportsAllDrives: true,
      }),
    `updateFileContent(${fileId})`,
  );
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
