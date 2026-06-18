/**
 * Canonical camera-trap Drive routing config: the three destination subfolder
 * names and the file-extension sets that route into each.
 *
 * Single source of truth shared by the ingestion pipeline (`drive-client.ts`)
 * and the field-upload endpoint (`/api/field-upload/v1/deployments`), so adding
 * an extension here ships to the field uploader with NO app release — the app
 * reads `routing` from the endpoint instead of hard-coding these constants.
 *
 * Plain data only — safe to import anywhere (NOT `server-only`).
 */

// Subfolder names on Google Drive (must match exactly).
export const DATA_TYPE_FOLDERS = {
  camarasTrampas: "camaras_trampas",
  grabadoresDeAudio: "grabadores_de_audio",
  ibutton: "ibutton",
} as const;

/**
 * Extra subfolder created in every deployment folder for audio-calibration
 * recordings. Deliberately NOT part of DATA_TYPE_FOLDERS / extension routing:
 * calibration files share audio extensions with grabadores_de_audio, so the
 * field uploader can't auto-route them — the field team drops them here by
 * hand. Counted on the datos page (counting ALL files, not extension-filtered)
 * but excluded from BirdNET and from the field-upload routing contract.
 */
export const AUDIO_CALIBRATION_FOLDER = "calibracion_de_audio";

export const IMAGE_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff", ".tif",
]);

export const VIDEO_EXTENSIONS = new Set([".mp4", ".avi", ".mov"]);

export const AUDIO_EXTENSIONS = new Set([
  ".wav", ".mp3", ".flac", ".wac", ".w4v", ".ogg", ".aac",
]);

export const IBUTTON_EXTENSIONS = new Set([".xlsx"]);

// Which extensions route into which subfolder. Camera folder takes images + video.
export const DATA_TYPE_EXTENSIONS: Record<keyof typeof DATA_TYPE_FOLDERS, Set<string>> = {
  camarasTrampas: new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]),
  grabadoresDeAudio: AUDIO_EXTENSIONS,
  ibutton: IBUTTON_EXTENSIONS,
};

/** Serializable shape returned in the endpoint's `routing` block. */
export interface FieldUploadRoutingConfig {
  subfolders: { camera: string; audio: string; ibutton: string };
  extensions: { camera: string[]; audio: string[]; ibutton: string[] };
}

/**
 * Build the JSON-serializable routing config for the field uploader. Extension
 * arrays are sorted for stable output (easy diffing / caching on the client).
 */
export function buildRoutingConfig(): FieldUploadRoutingConfig {
  return {
    subfolders: {
      camera: DATA_TYPE_FOLDERS.camarasTrampas,
      audio: DATA_TYPE_FOLDERS.grabadoresDeAudio,
      ibutton: DATA_TYPE_FOLDERS.ibutton,
    },
    extensions: {
      camera: [...DATA_TYPE_EXTENSIONS.camarasTrampas].sort(),
      audio: [...DATA_TYPE_EXTENSIONS.grabadoresDeAudio].sort(),
      ibutton: [...DATA_TYPE_EXTENSIONS.ibutton].sort(),
    },
  };
}
