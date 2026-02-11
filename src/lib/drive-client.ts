/**
 * Google Drive client for checking BioChoco deployment upload status.
 *
 * Singleton Drive API client using the same service account as sheets-client.
 * Own copy of getServiceAccountKey() to avoid coupling the two modules.
 */

import "server-only";

import { google, type drive_v3 } from "googleapis";
import type { ActionResult } from "./types";

// --- Types ---

export interface UploadStatus {
  camarasTrampas: number | null; // file count, null = subfolder not found or check failed
  grabadoresDeAudio: number | null;
  ibutton: number | null;
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
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
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
        status[key as keyof UploadStatus] = count;
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
