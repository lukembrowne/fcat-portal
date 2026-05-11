"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  Download,
  ChevronRight,
  Play,
  ScanSearch,
} from "lucide-react";
import type { AudioFileRow } from "../actions";
import { AudioPlayer } from "./audio-player";
import { AudioActionsMenu } from "./audio-actions-menu";
import { AudioMetadataSection } from "./audio-metadata-section";
import { AudioQaSection } from "./audio-qa-section";
import { StatusBadge } from "@/components/status-badge";
import { CollapsibleSection } from "@/components/collapsible-section";
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
  excluded: boolean;
  qaNotes: string | null;
  fieldNotes: string | null;
  uploadAudioFolderId: string | null;
}

interface BirdnetStats {
  totalDetections: number;
  totalSpecies: number;
  verified: number;
  pending: number;
}

function ReviewProgress({ reviewed, total }: { reviewed: number; total: number }) {
  const pct = total > 0 ? Math.round((reviewed / total) * 100) : 0;
  const isComplete = reviewed >= total;

  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground">·</span>
      <div className="w-32 h-2 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${isComplete ? "bg-emerald-500" : "bg-blue-500"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`tabular-nums ${isComplete ? "text-emerald-600 font-medium" : ""}`}>
        {reviewed.toLocaleString()}/{total.toLocaleString()} revisadas
      </span>
    </div>
  );
}

export function AudioFilesShell({
  deployment,
  files,
  isEditor,
  displayStatus = "unscanned",
  isBirdnetProcessing = false,
  birdnetStats = null,
  hasBirdnetDetections = false,
  reviewStats = null,
}: {
  deployment: DeploymentInfo;
  files: AudioFileRow[];
  isEditor: boolean;
  displayStatus?: string;
  isBirdnetProcessing?: boolean;
  birdnetStats?: BirdnetStats | null;
  hasBirdnetDetections?: boolean;
  reviewStats?: { verified: number; total: number } | null;
}) {
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
    setActiveFileId((prev) => (prev === driveFileId ? null : driveFileId));
  }

  const activeFile = activeFileId
    ? files.find((f) => f.driveFileId === activeFileId) ?? null
    : null;

  return (
    <div className={`max-w-screen-2xl mx-auto space-y-3 ${activeFileId ? "pb-40" : ""}`}>
      {/* Status Banner Card */}
      <div className="rounded-lg border bg-card px-4 py-2.5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0 flex-wrap">
            <Link href="/audio">
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <h1 className="text-lg font-bold shrink-0">{deployment.name}</h1>
            <StatusBadge status={displayStatus} type="audio-deployment" />
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              {files.length > 0 && (
                <span>{files.length.toLocaleString()} grabaciones</span>
              )}
              {birdnetStats && birdnetStats.totalDetections > 0 && (
                <span>
                  · {birdnetStats.totalDetections.toLocaleString()} detecciones · {birdnetStats.totalSpecies} especies
                </span>
              )}
              {reviewStats && reviewStats.total > 0 && (
                <ReviewProgress
                  reviewed={reviewStats.verified}
                  total={reviewStats.total}
                />
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 shrink-0">
            {isEditor && (
              <AudioActionsMenu
                deploymentId={deployment.id}
                uploadAudioFolderId={deployment.uploadAudioFolderId}
                isBirdnetProcessing={isBirdnetProcessing}
                hasBirdnetDetections={hasBirdnetDetections}
                hasFiles={files.length > 0}
              />
            )}
          </div>
        </div>

        {/* Collapsible details */}
        <div className="mt-2 border-t pt-2">
          <CollapsibleSection title="Detalles" defaultOpen={false}>
            {deployment.fieldNotes && (
              <div className="rounded-md border bg-amber-50 dark:bg-amber-950/20 px-3 py-2 mb-4">
                <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide mb-0.5">
                  Notas de campo
                </p>
                <p className="text-sm whitespace-pre-wrap">{deployment.fieldNotes}</p>
              </div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <AudioMetadataSection
                deployment={deployment}
                fileCount={files.length}
              />
              <AudioQaSection
                deploymentId={deployment.id}
                canEdit={isEditor}
                excluded={deployment.excluded ?? false}
                qaNotes={deployment.qaNotes}
              />
            </div>
          </CollapsibleSection>
        </div>
      </div>

      {/* Date-grouped sections */}
      {files.length === 0 ? (
        <div className="rounded-lg border bg-card px-6 py-10 text-center text-muted-foreground">
          {isEditor
            ? 'No hay archivos escaneados. Usa "Acciones → Escanear archivos" para buscar archivos en Drive.'
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

                        {/* Filename */}
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
