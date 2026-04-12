"use client";

import { useState, useRef, useCallback } from "react";
import { Upload, FileText, Image, X } from "lucide-react";
import { Button } from "@/components/ui/button";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_TOTAL_SIZE = 25 * 1024 * 1024; // 25 MB
const ALLOWED_EXTENSIONS = new Set(["pdf", "jpg", "jpeg", "png"]);
const ALLOWED_MIMES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);

interface FileDropzoneProps {
  id: string;
  files: File[];
  onChange: (files: File[]) => void;
  label: string;
  hint?: string;
  accept?: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function fileKey(f: File): string {
  return `${f.name}:${f.size}:${f.lastModified}`;
}

export function FileDropzone({
  id,
  files,
  onChange,
  label,
  hint,
  accept = ".pdf,.jpg,.jpeg,.png",
}: FileDropzoneProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const dragCounter = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const totalSize = files.reduce((sum, f) => sum + f.size, 0);

  const addFiles = useCallback(
    (incoming: File[]) => {
      const existingKeys = new Set(files.map(fileKey));
      const errs: string[] = [];
      const accepted: File[] = [];
      let runningTotal = totalSize;

      for (const file of incoming) {
        // Deduplicate
        if (existingKeys.has(fileKey(file))) continue;

        // Extension check
        const ext = getExtension(file.name);
        if (!ALLOWED_EXTENSIONS.has(ext)) {
          errs.push(`"${file.name}" — unsupported format. Allowed: PDF, JPEG, PNG`);
          continue;
        }

        // MIME check (best-effort; server does magic-number verification)
        if (file.type && !ALLOWED_MIMES.has(file.type)) {
          errs.push(`"${file.name}" — unsupported file type`);
          continue;
        }

        // Per-file size
        if (file.size > MAX_FILE_SIZE) {
          errs.push(`"${file.name}" — exceeds 10 MB limit (${formatFileSize(file.size)})`);
          continue;
        }

        // Aggregate size
        if (runningTotal + file.size > MAX_TOTAL_SIZE) {
          errs.push(`"${file.name}" — would exceed 25 MB total limit`);
          continue;
        }

        runningTotal += file.size;
        accepted.push(file);
        existingKeys.add(fileKey(file));
      }

      setErrors(errs);
      if (accepted.length > 0) {
        onChange([...files, ...accepted]);
      }
    },
    [files, onChange, totalSize],
  );

  const removeFile = useCallback(
    (index: number) => {
      onChange(files.filter((_, i) => i !== index));
      setErrors([]);
    },
    [files, onChange],
  );

  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    setIsDragOver(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) setIsDragOver(false);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setIsDragOver(false);
    const dropped = Array.from(e.dataTransfer.files);
    if (dropped.length > 0) addFiles(dropped);
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.target.files ?? []);
    if (selected.length > 0) addFiles(selected);
    // Reset input so the same file(s) can be re-selected
    e.target.value = "";
  }

  function handleClick() {
    inputRef.current?.click();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      inputRef.current?.click();
    }
  }

  return (
    <div>
      <label className="text-sm font-medium leading-none" htmlFor={id}>
        {label}
      </label>
      {hint && <p className="text-sm text-muted-foreground mt-1">{hint}</p>}

      {/* Drop zone */}
      <div
        role="button"
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        className={`mt-2 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 cursor-pointer transition-colors ${
          isDragOver
            ? "border-primary bg-primary/5"
            : "border-muted-foreground/25 bg-muted/50 hover:border-muted-foreground/50"
        }`}
      >
        <Upload className="h-6 w-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground text-center">
          Drag files here or click to browse
        </p>
        <p className="text-xs text-muted-foreground/70">
          PDF, JPEG, PNG — max 10 MB each, 25 MB total
        </p>
      </div>

      <input
        ref={inputRef}
        id={id}
        type="file"
        multiple
        accept={accept}
        onChange={handleInputChange}
        className="sr-only"
        aria-label={label}
        tabIndex={-1}
      />

      {/* File list */}
      {files.length > 0 && (
        <ul className="mt-3 space-y-1">
          {files.map((file, i) => (
            <li
              key={fileKey(file)}
              className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-1.5 text-sm"
            >
              {file.type === "application/pdf" ? (
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : (
                <Image className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate flex-1 min-w-0">{file.name}</span>
              <span className="text-muted-foreground shrink-0">
                {formatFileSize(file.size)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                onClick={(e) => {
                  e.stopPropagation();
                  removeFile(i);
                }}
                aria-label={`Remove ${file.name}`}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
          <li className="px-3 pt-1 text-xs text-muted-foreground">
            Total:{" "}
            <span className={totalSize > MAX_TOTAL_SIZE ? "text-destructive font-medium" : ""}>
              {formatFileSize(totalSize)}
            </span>{" "}
            / 25 MB
          </li>
        </ul>
      )}

      {/* Validation errors */}
      {errors.length > 0 && (
        <ul className="mt-2 space-y-0.5" role="alert">
          {errors.map((err) => (
            <li key={err} className="text-sm text-destructive">
              {err}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
