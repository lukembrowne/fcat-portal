/**
 * File upload validation for public forms.
 *
 * - Magic-number detection via `file-type`
 * - Per-file and aggregate size limits
 * - Filename sanitization
 */

import { fileTypeFromBuffer } from "file-type";

const ALLOWED_MIMES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_TOTAL_SIZE = 25 * 1024 * 1024; // 25 MB

export interface ValidatedFile {
  buffer: Buffer;
  originalName: string;
  sanitizedName: string;
  mimeType: string;
  size: number;
}

/**
 * Sanitize a filename: strip path separators, null bytes, RTL overrides,
 * and truncate to 200 chars.
 */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[\\/]/g, "_") // path separators
    .replace(/\0/g, "") // null bytes
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "") // RTL/LTR overrides
    .replace(/[<>:"|?*]/g, "_") // Windows-illegal chars
    .trim()
    .slice(0, 200);
}

export interface ValidationError {
  field: string;
  message: string;
}

/**
 * Validate and process an array of uploaded files.
 * Returns validated files or an array of errors.
 */
export async function validateUploads(
  files: File[],
  fieldName = "files"
): Promise<{ files: ValidatedFile[] } | { errors: ValidationError[] }> {
  const errors: ValidationError[] = [];
  const validated: ValidatedFile[] = [];
  let totalSize = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];

    if (file.size > MAX_FILE_SIZE) {
      errors.push({
        field: `${fieldName}[${i}]`,
        message: `File "${file.name}" exceeds 10 MB limit`,
      });
      continue;
    }

    totalSize += file.size;
    if (totalSize > MAX_TOTAL_SIZE) {
      errors.push({
        field: fieldName,
        message: "Total upload size exceeds 25 MB limit",
      });
      break;
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const detected = await fileTypeFromBuffer(buffer);
    const mime = detected?.mime ?? file.type;

    if (!ALLOWED_MIMES.has(mime)) {
      errors.push({
        field: `${fieldName}[${i}]`,
        message: `Unsupported file format for "${file.name}". Allowed: PDF, JPEG, PNG`,
      });
      continue;
    }

    validated.push({
      buffer,
      originalName: file.name,
      sanitizedName: sanitizeFilename(file.name),
      mimeType: mime,
      size: file.size,
    });
  }

  if (errors.length > 0) {
    return { errors };
  }

  return { files: validated };
}
