/**
 * Google Drive client for BioChoco upload status and Camera Trap workflows.
 *
 * Singleton Drive API client using the same service account as sheets-client.
 * Own copy of getServiceAccountKey() to avoid coupling the two modules.
 */

import "server-only";

import { google, type drive_v3 } from "googleapis";
import { promises as fs } from "fs";
import path from "path";
import type { ActionResult } from "./types";

// --- Types ---

export interface UploadStatus {
  camarasTrampas: number | null; // file count, null = subfolder not found or check failed
  grabadoresDeAudio: number | null;
  ibutton: number | null;
  subfolderIds: {
    camarasTrampas: string | null;
    grabadoresDeAudio: string | null;
    ibutton: string | null;
  };
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
    console.log(`[Drive] Checking folder ${folderId}`);
    const foldersRes = await drive.files.list({
      q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "files(id, name)",
      pageSize: 20,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const subfolders = foldersRes.data.files ?? [];
    console.log(`[Drive] Found ${subfolders.length} subfolders:`, subfolders.map((f) => f.name));

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
      subfolderIds: {
        camarasTrampas: subfolderMap.get(DATA_TYPE_FOLDERS.camarasTrampas) ?? null,
        grabadoresDeAudio: subfolderMap.get(DATA_TYPE_FOLDERS.grabadoresDeAudio) ?? null,
        ibutton: subfolderMap.get(DATA_TYPE_FOLDERS.ibutton) ?? null,
      },
    };

    const countPromises = Object.entries(DATA_TYPE_FOLDERS).map(
      async ([key, folderName]) => {
        const subfolderId = subfolderMap.get(folderName);
        if (!subfolderId) {
          console.log(`[Drive] ${folderName}: subfolder not found in parent`);
          return { key, count: 0 };
        }

        try {
          const filesRes = await drive.files.list({
            q: `'${subfolderId}' in parents and trashed = false`,
            fields: "files(id)",
            pageSize: 1000,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
          });
          const count = filesRes.data.files?.length ?? 0;
          console.log(`[Drive] ${folderName} (${subfolderId}): ${count} files`);
          return { key, count };
        } catch (err) {
          console.error(`[Drive] Error counting files in ${folderName}:`, err);
          return { key, count: null };
        }
      }
    );

    const results = await Promise.allSettled(countPromises);

    for (const result of results) {
      if (result.status === "fulfilled") {
        const { key, count } = result.value;
        const k = key as keyof typeof DATA_TYPE_FOLDERS;
        status[k] = count;
      }
    }

    return { success: true, data: status };
  } catch (err) {
    console.error(`[Drive] Failed to check folder ${folderId}:`, err);
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
    const res = await drive.files.list({
      q: `'${rootFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "nextPageToken, files(id, name)",
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

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
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, size, modifiedTime)",
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

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

  // Recurse into subfolders
  for (const sub of subfolders) {
    const subPath = pathPrefix ? `${pathPrefix}/${sub.name}` : sub.name;
    const subResult = await listMediaRecursive(sub.id, subPath);
    imageFiles.push(...subResult.images);
    videoFiles.push(...subResult.videos);
  }

  return { images: imageFiles, videos: videoFiles };
}

/**
 * Download a single file from Drive to a local path.
 * Retries once on failure.
 */
export async function downloadFile(
  fileId: string,
  destPath: string
): Promise<void> {
  const drive = getDrive();

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await drive.files.get(
        { fileId, alt: "media", supportsAllDrives: true },
        { responseType: "arraybuffer" }
      );

      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.writeFile(destPath, Buffer.from(res.data as ArrayBuffer));
      return;
    } catch (err) {
      if (attempt === 0) {
        console.warn(`[Drive] Download retry for ${fileId}:`, err instanceof Error ? err.message : err);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Download all images in a deployment folder to a local directory.
 * Uses batches of 10 with Promise.all. Retries once per file; skips on second failure.
 */
export async function downloadDeploymentImages(
  imageFiles: DriveImageFile[],
  destDir: string
): Promise<{ downloaded: number; failed: number; pathMap: Map<string, string> }> {
  let downloaded = 0;
  let failed = 0;
  const pathMap = new Map<string, string>(); // driveFileId → local path

  const BATCH_SIZE = 10;

  for (let i = 0; i < imageFiles.length; i += BATCH_SIZE) {
    const batch = imageFiles.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async (file) => {
        const localPath = path.join(destDir, file.relativePath);
        try {
          await downloadFile(file.id, localPath);
          pathMap.set(file.id, localPath);
          downloaded++;
        } catch (err) {
          console.error(`[Drive] Failed to download ${file.name} (${file.id}):`, err instanceof Error ? err.message : err);
          failed++;
        }
      })
    );
  }

  return { downloaded, failed, pathMap };
}

/**
 * Download a single file's content to a Buffer (for image proxy serving).
 */
export async function downloadFileToBuffer(
  fileId: string
): Promise<Buffer> {
  const drive = getDrive();

  const res = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );

  return Buffer.from(res.data as ArrayBuffer);
}

// ---------------------------------------------------------------------------
// Create Deployment Folder (with subfolders)
// ---------------------------------------------------------------------------

export interface CreatedFolder {
  id: string;
  name: string;
  webViewLink: string;
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
    console.log(`[Drive] Reusing existing folder: ${deploymentName} (${existing.id})`);
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
    console.log(`[Drive] Created folder: ${deploymentName} (${folderId})`);
  }

  // List existing subfolders to avoid duplicates
  const subfoldersRes = await drive.files.list({
    q: `'${folderId}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
    fields: "files(id, name)",
    pageSize: 20,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const existingSubfolders = new Set(
    (subfoldersRes.data.files ?? []).map((f) => f.name)
  );

  // Create missing subfolders
  const subfolderNames = Object.values(DATA_TYPE_FOLDERS);
  for (const subName of subfolderNames) {
    if (existingSubfolders.has(subName)) {
      console.log(`[Drive] Subfolder already exists: ${subName}`);
      continue;
    }

    await drive.files.create({
      requestBody: {
        name: subName,
        mimeType: FOLDER_MIME,
        parents: [folderId],
      },
      fields: "id",
      supportsAllDrives: true,
    });
    console.log(`[Drive] Created subfolder: ${subName}`);
  }

  return { id: folderId, name: deploymentName, webViewLink };
}
