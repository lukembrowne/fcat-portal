"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AudioLines,
  ArrowLeft,
  Download,
  FolderSync,
  Loader2,
  MapPin,
  Calendar,
  ChevronRight,
  Play,
  ScanSearch,
} from "lucide-react";
import { scanDeploymentAudio } from "../actions";
import type { AudioFileRow } from "../actions";
import { AudioPlayer } from "./audio-player";
import { parseRecordingTimestamp } from "@/lib/audio-filename";

/** Format a YYYY-MM-DD date string in Spanish locale */
function formatDateHeading(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00"); // noon to avoid timezone shifts
  return d.toLocaleDateString("es-EC", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

interface DateGroup {
  dateKey: string;
  label: string;
  files: (AudioFileRow & { time: string | null })[];
}

interface DeploymentInfo {
  id: number;
  name: string;
  siteName: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  latitude: number | null;
  longitude: number | null;
  ctProjectName: string | null;
}

export function AudioFilesShell({
  deployment,
  files,
  isEditor,
}: {
  deployment: DeploymentInfo;
  files: AudioFileRow[];
  isEditor: boolean;
}) {
  const router = useRouter();
  const [scanning, setScanning] = useState(false);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);

  // Group files by date
  const dateGroups = useMemo(() => {
    const groups = new Map<string, (AudioFileRow & { time: string | null })[]>();
    const noDate: (AudioFileRow & { time: string | null })[] = [];

    for (const file of files) {
      const parsed = parseRecordingTimestamp(file.filename);
      if (parsed) {
        const existing = groups.get(parsed.date) ?? [];
        existing.push({ ...file, time: parsed.time });
        groups.set(parsed.date, existing);
      } else {
        noDate.push({ ...file, time: null });
      }
    }

    // Sort dates descending (most recent first)
    const sortedKeys = Array.from(groups.keys()).sort((a, b) =>
      b.localeCompare(a)
    );

    const result: DateGroup[] = sortedKeys.map((dateKey) => ({
      dateKey,
      label: formatDateHeading(dateKey),
      files: groups.get(dateKey)!.sort((a, b) =>
        (a.time ?? "").localeCompare(b.time ?? "")
      ),
    }));

    // Add "Sin fecha" group at the end if any
    if (noDate.length > 0) {
      result.push({
        dateKey: "__no_date__",
        label: "Sin fecha",
        files: noDate.sort((a, b) => a.filename.localeCompare(b.filename)),
      });
    }

    return result;
  }, [files]);

  // Default: only the most recent date expanded
  const [expandedDates, setExpandedDates] = useState<Set<string>>(() => {
    if (dateGroups.length > 0) {
      return new Set([dateGroups[0].dateKey]);
    }
    return new Set();
  });

  function toggleDate(dateKey: string) {
    setExpandedDates((prev) => {
      const next = new Set(prev);
      if (next.has(dateKey)) {
        next.delete(dateKey);
      } else {
        next.add(dateKey);
      }
      return next;
    });
  }

  function handlePlay(driveFileId: string) {
    // Spotify behavior: clicking the currently-playing file pauses it
    setActiveFileId((prev) => (prev === driveFileId ? null : driveFileId));
  }

  async function handleScan() {
    setScanning(true);
    try {
      await scanDeploymentAudio(deployment.id);
      router.refresh();
    } catch {
      // silent
    }
    setScanning(false);
  }

  const activeFile = activeFileId
    ? files.find((f) => f.driveFileId === activeFileId) ?? null
    : null;

  return (
    <div className={`space-y-4 ${activeFileId ? "pb-40" : ""}`}>
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/audio">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <AudioLines className="h-6 w-6 shrink-0" />
            <span className="truncate">{deployment.name}</span>
          </h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground mt-1">
            {deployment.siteName && (
              <span className="flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {deployment.siteName}
              </span>
            )}
            {deployment.dateStart && (
              <span className="flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                {deployment.dateStart}
                {deployment.dateEnd ? ` → ${deployment.dateEnd}` : ""}
              </span>
            )}
            {deployment.ctProjectName && (
              <Badge variant="outline">{deployment.ctProjectName}</Badge>
            )}
          </div>
        </div>
        {isEditor && (
          <Button
            onClick={handleScan}
            disabled={scanning}
            variant="outline"
            size="sm"
          >
            {scanning ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
            ) : (
              <FolderSync className="h-4 w-4 mr-1.5" />
            )}
            Escanear
          </Button>
        )}
      </div>

      {/* Date-grouped sections */}
      {files.length === 0 ? (
        <div className="rounded-xl border p-8 text-center text-muted-foreground">
          {isEditor
            ? 'No hay archivos escaneados. Haz clic en "Escanear" para buscar archivos en Drive.'
            : "No hay archivos de audio."}
        </div>
      ) : (
        <div className="space-y-2">
          {dateGroups.map((group) => {
            const isExpanded = expandedDates.has(group.dateKey);
            return (
              <div key={group.dateKey} className="rounded-xl border overflow-hidden">
                {/* Date header */}
                <button
                  type="button"
                  onClick={() => toggleDate(group.dateKey)}
                  className="w-full flex items-center gap-2 px-4 py-2.5 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
                >
                  <ChevronRight
                    className={`h-4 w-4 text-muted-foreground shrink-0 transition-transform ${
                      isExpanded ? "rotate-90" : ""
                    }`}
                  />
                  <span className="font-medium text-sm">{group.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {group.files.length} grabaciones
                  </span>
                </button>

                {/* File rows */}
                {isExpanded && (
                  <div className="divide-y">
                    {group.files.map((file) => (
                      <div
                        key={file.id}
                        className="flex items-center gap-3 px-4 py-1.5 text-sm hover:bg-muted/20"
                      >
                        {/* Time or filename */}
                        <span className="font-mono text-xs tabular-nums text-muted-foreground w-16 shrink-0">
                          {file.time ?? "—"}
                        </span>

                        {/* Filename (for "Sin fecha" group or always visible) */}
                        {group.dateKey === "__no_date__" ? (
                          <span className="font-mono text-xs truncate flex-1 min-w-0">
                            {file.filename}
                          </span>
                        ) : (
                          <span className="font-mono text-xs truncate flex-1 min-w-0 text-muted-foreground">
                            {file.filename}
                          </span>
                        )}

                        {/* Detection count badge */}
                        {file.detectionCount > 0 && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                            {file.detectionCount}
                          </Badge>
                        )}

                        {/* Actions */}
                        <div className="flex items-center gap-1 shrink-0">
                          {file.playable && file.driveFileId && (
                            <>
                              <Button
                                size="sm"
                                variant={
                                  activeFileId === file.driveFileId
                                    ? "default"
                                    : "ghost"
                                }
                                className="h-7 w-7 p-0"
                                onClick={() => handlePlay(file.driveFileId!)}
                              >
                                <Play className="h-3 w-3" />
                              </Button>
                              <Link href={`/audio/${deployment.id}/annotate/${file.id}`}>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 w-7 p-0"
                                  title="Anotar"
                                >
                                  <ScanSearch className="h-3 w-3" />
                                </Button>
                              </Link>
                            </>
                          )}
                          {file.driveFileId && (
                            <a
                              href={`/api/audio/stream?fileId=${encodeURIComponent(file.driveFileId)}&download=true`}
                              download
                            >
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 w-7 p-0"
                              >
                                <Download className="h-3 w-3" />
                              </Button>
                            </a>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Footer */}
      {files.length > 0 && (
        <p className="text-sm text-muted-foreground">
          {files.length.toLocaleString()} grabaciones
        </p>
      )}

      {/* Sticky bottom audio player */}
      {activeFileId && (
        <AudioPlayer
          fileId={activeFileId}
          file={activeFile}
          onClose={() => setActiveFileId(null)}
        />
      )}
    </div>
  );
}
