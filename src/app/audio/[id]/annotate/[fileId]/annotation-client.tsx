"use client";

import { useState, useEffect, useCallback, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  SpeciesSidebar,
  getVisibleSpecies,
  getStoredDisplay,
  DISPLAY_KEY,
  type NameDisplay,
} from "@/components/species-sidebar";
import { Button } from "@/components/ui/button";
import { Calendar, ChevronLeft, ChevronRight, Loader2, Trash2, Play, Pause, SkipBack, SkipForward } from "lucide-react";
import type { Species } from "@/db/schema";
import type { SpectrogramMetadata } from "@/lib/audio-cache";
import { SpectrogramOverlay, type AudioBoxData } from "./spectrogram-overlay";
import { useAudioAnnotationShortcuts } from "@/hooks/use-audio-annotation-shortcuts";
import {
  createAudioDetection,
  deleteAudioDetection,
  assignAudioSpecies,
  verifyAudioIdentification,
  rejectAudioIdentification,
  verifyAllAudioAndAdvance,
} from "@/app/audio/annotation-actions";

export interface AudioDetectionData {
  id: number;
  startTime: number;
  endTime: number;
  minFreq: number;
  maxFreq: number;
  confidence: number | null;
  modelVersion: string | null;
  identification: {
    id: number;
    species: string;
    confidence: number | null;
    verificationStatus: string;
    correctedSpecies: string | null;
  } | null;
}

interface AudioAnnotationClientProps {
  audioFileId: number;
  deploymentId: number;
  filename: string;
  driveFileId: string | null;
  format: string | null;
  detections: AudioDetectionData[];
  speciesList: Species[];
  recentSpecies: Species[];
  isEditor: boolean;
  prevFileId: number | null;
  nextFileId: number | null;
  currentIndex: number;
  totalFiles: number;
  recordingDate?: string | null;
  recordingTime?: string | null;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Format YYYY-MM-DD in Spanish, e.g. "1 de febrero de 2026" */
function formatSpanishDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("es-EC", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** Format HH:MM:SS to HH:MM */
function formatTimeShort(time: string): string {
  return time.slice(0, 5);
}

function getSpeciesDisplayName(
  scientificName: string | null | undefined,
  speciesList: Species[],
  nameDisplay: NameDisplay
): string | null {
  if (!scientificName || scientificName === "unknown") return null;
  const sp = speciesList.find((s) => s.scientificName === scientificName);
  if (!sp) return scientificName;
  switch (nameDisplay) {
    case "common":
      return sp.commonName || sp.scientificName;
    case "spanish":
      return sp.spanishName || sp.commonName || sp.scientificName;
    case "scientific":
      return sp.scientificName;
  }
}

export function AudioAnnotationClient({
  audioFileId,
  deploymentId,
  filename,
  driveFileId,
  format,
  detections,
  speciesList,
  recentSpecies,
  isEditor,
  prevFileId,
  nextFileId,
  currentIndex,
  totalFiles,
  recordingDate,
  recordingTime,
}: AudioAnnotationClientProps) {
  const router = useRouter();
  const [selectedDetectionId, setSelectedDetectionId] = useState<number | null>(
    null
  );
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [nameDisplay, setNameDisplay] = useState<NameDisplay>(getStoredDisplay);
  const [, startTransition] = useTransition();
  const [spectrogramReady, setSpectrogramReady] = useState(false);
  const [spectrogramError, setSpectrogramError] = useState<string | null>(null);
  const [spectrogramStage, setSpectrogramStage] = useState<string | null>(null);
  const [spectrogramFileSize, setSpectrogramFileSize] = useState<number | null>(null);
  const [metadata, setMetadata] = useState<SpectrogramMetadata | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const selectionEndRef = useRef<number | null>(null);

  const [retryCount, setRetryCount] = useState(0);
  const spectrogramUrl = `/api/audio/spectrogram?fileId=${audioFileId}&t=${retryCount}`;
  const audioStreamUrl = driveFileId ? `/api/audio/stream?fileId=${driveFileId}` : null;

  // Poll for spectrogram readiness (max ~3 minutes = 90 polls × 2s)
  const MAX_POLLS = 90;
  useEffect(() => {
    let cancelled = false;
    let pollCount = 0;

    async function checkMeta() {
      if (pollCount >= MAX_POLLS) {
        setSpectrogramError(
          "Tiempo de espera agotado generando espectrograma. Intente de nuevo."
        );
        return;
      }
      pollCount++;

      try {
        const res = await fetch(
          `/api/audio/spectrogram/meta?fileId=${audioFileId}`
        );
        const data = await res.json();
        if (cancelled) return;

        if (data.ready) {
          setMetadata(data as SpectrogramMetadata);
          setSpectrogramReady(true);
          setSpectrogramError(null);
          setSpectrogramStage(null);
        } else if (data.error && !data.stage) {
          setSpectrogramError(data.error);
        } else {
          // Not ready yet — update stage and poll again
          if (data.stage) setSpectrogramStage(data.stage);
          if (data.fileSize) setSpectrogramFileSize(data.fileSize);
          setTimeout(checkMeta, 2000);
        }
      } catch {
        if (!cancelled) {
          setSpectrogramError("Error de conexión");
        }
      }
    }

    checkMeta();
    return () => {
      cancelled = true;
    };
  }, [audioFileId, retryCount]);

  // Handle broken spectrogram image — reset to loading and re-poll (max 3 retries)
  const MAX_RETRIES = 3;
  const handleImageError = useCallback(() => {
    setRetryCount((c) => {
      if (c >= MAX_RETRIES) {
        setSpectrogramError("No se pudo cargar la imagen del espectrograma.");
        return c;
      }
      setSpectrogramReady(false);
      setMetadata(null);
      return c + 1;
    });
  }, []);

  const cycleDisplay = useCallback(() => {
    setNameDisplay((prev) => {
      const cycle: NameDisplay[] = ["common", "spanish", "scientific"];
      const idx = cycle.indexOf(prev);
      const next = cycle[(idx + 1) % cycle.length];
      localStorage.setItem(DISPLAY_KEY, next);
      return next;
    });
  }, []);

  // Current species for sidebar highlight
  const selectedDetection = detections.find(
    (d) => d.id === selectedDetectionId
  );
  const currentSpecies =
    selectedDetection?.identification?.correctedSpecies ??
    selectedDetection?.identification?.species ??
    null;

  // Build box data for the overlay
  const boxes: AudioBoxData[] = detections.map((det) => {
    const sciName = det.identification?.correctedSpecies ?? det.identification?.species ?? null;
    return {
      id: det.id,
      startTime: det.startTime,
      endTime: det.endTime,
      minFreq: det.minFreq,
      maxFreq: det.maxFreq,
      species: sciName,
      displayLabel: getSpeciesDisplayName(sciName, speciesList, nameDisplay),
      verificationStatus: det.identification?.verificationStatus ?? "unverified",
    };
  });

  const handleSelectSpecies = useCallback(
    (scientificName: string) => {
      if (!selectedDetectionId) return;
      const det = detections.find((d) => d.id === selectedDetectionId);
      if (!det?.identification) return;

      startTransition(async () => {
        await assignAudioSpecies(det.identification!.id, scientificName);
        router.refresh();
      });
    },
    [selectedDetectionId, detections, router]
  );

  const handleDrawComplete = useCallback(
    (box: { startTime: number; endTime: number; minFreq: number; maxFreq: number }) => {
      startTransition(async () => {
        const result = await createAudioDetection(audioFileId, box);
        if (result.success) {
          setSelectedDetectionId(result.data.detectionId);
        }
        router.refresh();
      });
    },
    [audioFileId, router]
  );

  const handleDeleteDetection = useCallback(
    (detectionId: number) => {
      startTransition(async () => {
        await deleteAudioDetection(detectionId);
        if (selectedDetectionId === detectionId) {
          setSelectedDetectionId(null);
        }
        router.refresh();
      });
    },
    [selectedDetectionId, router]
  );

  // Playback controls
  const handlePlayPause = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      selectionEndRef.current = null;
      audio.play();
    } else {
      audio.pause();
    }
  }, []);

  const handleSeek = useCallback((time: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(time, audio.duration || 0));
  }, []);

  const handlePlaySelection = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !selectedDetection) return;
    audio.currentTime = selectedDetection.startTime;
    selectionEndRef.current = selectedDetection.endTime;
    audio.play();
  }, [selectedDetection]);

  // Smooth 60fps cursor updates via requestAnimationFrame
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    let rafId: number | null = null;

    function tick() {
      const a = audioRef.current;
      if (!a) return;
      setCurrentTime(a.currentTime);
      // Stop at selection end
      if (selectionEndRef.current != null && a.currentTime >= selectionEndRef.current) {
        a.pause();
        selectionEndRef.current = null;
      }
      rafId = requestAnimationFrame(tick);
    }

    function onPlay() {
      setIsPlaying(true);
      rafId = requestAnimationFrame(tick);
    }
    function onPause() {
      setIsPlaying(false);
      if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
      // Sync final position
      setCurrentTime(audioRef.current?.currentTime ?? 0);
    }
    function onEnded() {
      setIsPlaying(false);
      if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
      setCurrentTime(0);
    }
    function onSeeked() {
      setCurrentTime(audioRef.current?.currentTime ?? 0);
    }

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("seeked", onSeeked);

    return () => {
      if (rafId != null) cancelAnimationFrame(rafId);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("seeked", onSeeked);
    };
  }, []);

  // Verify/reject handlers
  const handleVerifySelected = useCallback(() => {
    if (!selectedDetection?.identification) return;
    startTransition(async () => {
      await verifyAudioIdentification(selectedDetection.identification!.id);
      router.refresh();
    });
  }, [selectedDetection, router]);

  const handleRejectSelected = useCallback(() => {
    if (!selectedDetection?.identification) return;
    startTransition(async () => {
      await rejectAudioIdentification(selectedDetection.identification!.id);
      router.refresh();
    });
  }, [selectedDetection, router]);

  const handleQuickVerifyAll = useCallback(() => {
    const unverifiedIds = detections
      .filter((d) => d.identification?.verificationStatus === "unverified")
      .map((d) => d.identification!.id);

    startTransition(async () => {
      const result = await verifyAllAudioAndAdvance(unverifiedIds, deploymentId, audioFileId);
      if (result.success && result.data.nextFileId) {
        router.push(`/audio/${deploymentId}/annotate/${result.data.nextFileId}`);
      } else {
        router.refresh();
      }
    });
  }, [detections, deploymentId, audioFileId, router]);

  // Visible species for number-key assignment
  const visibleSpecies = getVisibleSpecies(speciesList, recentSpecies, searchQuery);

  // Keyboard shortcuts
  useAudioAnnotationShortcuts({
    enabled: true,
    onPlayPause: handlePlayPause,
    onSeekBack: () => handleSeek((audioRef.current?.currentTime ?? 0) - 5),
    onSeekForward: () => handleSeek((audioRef.current?.currentTime ?? 0) + 5),
    onPlaySelection: handlePlaySelection,
    onVerify: handleVerifySelected,
    onReject: handleRejectSelected,
    onQuickVerifyAll: handleQuickVerifyAll,
    onDeleteSelected: () => {
      if (selectedDetectionId) handleDeleteDetection(selectedDetectionId);
    },
    onNext: () => {
      if (nextFileId) router.push(`/audio/${deploymentId}/annotate/${nextFileId}`);
    },
    onPrev: () => {
      if (prevFileId) router.push(`/audio/${deploymentId}/annotate/${prevFileId}`);
    },
    onSelectDetection: (index) => {
      if (index < detections.length) {
        setSelectedDetectionId(detections[index].id);
      }
    },
    onDeselect: () => {
      setSelectedDetectionId(null);
      setSearchQuery("");
    },
    onAssignSpeciesByIndex: (index) => {
      if (index < visibleSpecies.length) {
        handleSelectSpecies(visibleSpecies[index].scientificName);
      }
    },
    detectionCount: detections.length,
    selectedDetectionId,
    searchInputRef,
  });

  return (
    <div className="flex flex-1 min-h-0">
      {/* Hidden audio element */}
      {audioStreamUrl && (
        <audio ref={audioRef} src={audioStreamUrl} preload="auto" />
      )}

      {/* Left sidebar — Species list */}
      <aside className="w-56 shrink-0 flex flex-col min-w-0 overflow-hidden border-r bg-background">
        <SpeciesSidebar
          speciesList={speciesList}
          recentSpecies={recentSpecies}
          selectedDetectionId={selectedDetectionId}
          currentSpecies={currentSpecies}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onSelectSpecies={handleSelectSpecies}
          searchInputRef={searchInputRef}
          nameDisplay={nameDisplay}
          onCycleDisplay={cycleDisplay}
        />
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Detection cards strip */}
        {detections.length > 0 && (
          <div className="px-4 py-2 border-b shrink-0">
            <div className="flex gap-2 overflow-x-auto">
              {detections.map((det) => (
                <div
                  key={det.id}
                  className={`shrink-0 flex items-center gap-1 px-3 py-1.5 rounded border text-xs cursor-pointer group ${
                    selectedDetectionId === det.id
                      ? "border-primary bg-primary/10"
                      : "border-border hover:bg-accent"
                  }`}
                  onClick={() =>
                    setSelectedDetectionId((prev) =>
                      prev === det.id ? null : det.id
                    )
                  }
                >
                  <span>
                    {det.startTime.toFixed(1)}s – {det.endTime.toFixed(1)}s
                    {" · "}
                    {(det.minFreq / 1000).toFixed(1)}–{(det.maxFreq / 1000).toFixed(1)} kHz
                  </span>
                  {(() => {
                    const sciName = det.identification?.correctedSpecies ?? det.identification?.species ?? null;
                    const label = getSpeciesDisplayName(sciName, speciesList, nameDisplay);
                    return label ? (
                      <span className="text-muted-foreground">{label}</span>
                    ) : null;
                  })()}
                  {isEditor && (
                    <button
                      type="button"
                      className="ml-1 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteDetection(det.id);
                      }}
                      title="Eliminar detección"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recording context info */}
        {recordingDate && (
          <div className="px-4 py-1.5 border-b shrink-0 flex items-center gap-2 text-xs text-muted-foreground">
            <Calendar className="h-3 w-3" />
            <span>
              {formatSpanishDate(recordingDate)}
              {recordingTime ? ` \u00b7 ${formatTimeShort(recordingTime)}` : ""}
              {metadata ? ` (${formatTime(metadata.duration)})` : ""}
            </span>
          </div>
        )}

        {/* Spectrogram display — natural height, no flex-1 stretching */}
        <div className="shrink-0 relative">
          {!spectrogramReady && !spectrogramError && (
            <div className="flex items-center justify-center py-24">
              <div className="flex flex-col items-center gap-3 text-muted-foreground">
                <Loader2 className="h-8 w-8 animate-spin" />
                <p className="text-sm">
                  {spectrogramStage === "downloading"
                    ? `Descargando audio${spectrogramFileSize ? ` (${(spectrogramFileSize / 1024 / 1024).toFixed(1)} MB)` : ""}...`
                    : "Generando espectrograma..."}
                </p>
              </div>
            </div>
          )}

          {spectrogramError && (
            <div className="flex items-center justify-center py-24">
              <div className="flex flex-col items-center gap-3 text-muted-foreground max-w-md text-center">
                <p className="text-sm text-red-400">{spectrogramError}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSpectrogramError(null);
                    setSpectrogramReady(false);
                    router.refresh();
                  }}
                >
                  Reintentar
                </Button>
              </div>
            </div>
          )}

          {spectrogramReady && metadata && (
            <SpectrogramOverlay
              spectrogramUrl={spectrogramUrl}
              metadata={metadata}
              boxes={boxes}
              selectedBoxId={selectedDetectionId}
              editable={isEditor}
              currentTime={currentTime}
              onBoxClick={(box) =>
                setSelectedDetectionId((prev) =>
                  prev === box.id ? null : box.id
                )
              }
              onDrawComplete={handleDrawComplete}
              onSeekClick={handleSeek}
              onImageError={handleImageError}
            />
          )}
        </div>

        {/* Bottom controls */}
        <div className="px-4 py-2 border-t shrink-0 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {audioStreamUrl && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => handleSeek((audioRef.current?.currentTime ?? 0) - 5)}
                  title="Retroceder 5s ( [ )"
                >
                  <SkipBack className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={handlePlayPause}
                  title={isPlaying ? "Pausar (Espacio)" : "Reproducir (Espacio)"}
                >
                  {isPlaying ? (
                    <Pause className="h-4 w-4" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => handleSeek((audioRef.current?.currentTime ?? 0) + 5)}
                  title="Avanzar 5s ( ] )"
                >
                  <SkipForward className="h-3.5 w-3.5" />
                </Button>
                <span className="text-xs text-muted-foreground tabular-nums min-w-[4rem]">
                  {formatTime(currentTime)}
                  {metadata ? ` / ${formatTime(metadata.duration)}` : ""}
                </span>
              </>
            )}
            {!audioStreamUrl && metadata && (
              <span className="text-xs text-muted-foreground">
                {metadata.duration.toFixed(1)}s · {metadata.sampleRate}Hz
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!prevFileId}
              asChild={!!prevFileId}
            >
              {prevFileId ? (
                <Link
                  href={`/audio/${deploymentId}/annotate/${prevFileId}`}
                >
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Anterior
                </Link>
              ) : (
                <span>
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Anterior
                </span>
              )}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!nextFileId}
              asChild={!!nextFileId}
            >
              {nextFileId ? (
                <Link
                  href={`/audio/${deploymentId}/annotate/${nextFileId}`}
                >
                  Siguiente
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Link>
              ) : (
                <span>
                  Siguiente
                  <ChevronRight className="h-4 w-4 ml-1" />
                </span>
              )}
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href={`/audio/${deploymentId}`}>
                Volver
              </Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
