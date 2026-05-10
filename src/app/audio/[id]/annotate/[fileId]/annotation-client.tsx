"use client";

import { useState, useEffect, useCallback, useMemo, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  SpeciesSidebar,
  getStoredDisplay,
  DISPLAY_KEY,
  type NameDisplay,
} from "@/components/species-sidebar";

// Audio annotation still uses the legacy "flat visible list" for hotkey 1-9/0
// assignment. Camera-trap now uses stable project-wide hotkey slots; audio
// will get the same treatment in a follow-up.
function getVisibleSpecies(
  speciesList: Species[],
  frequentSpecies: Species[],
  searchQuery: string
): Species[] {
  const filtered = searchQuery.trim()
    ? speciesList.filter((sp) => {
        const q = searchQuery.toLowerCase();
        return (
          sp.scientificName.toLowerCase().includes(q) ||
          sp.commonName.toLowerCase().includes(q) ||
          (sp.spanishName && sp.spanishName.toLowerCase().includes(q))
        );
      })
    : speciesList;
  const showFrequent = frequentSpecies.length > 0 && !searchQuery.trim();
  const result: Species[] = [];
  if (showFrequent) result.push(...frequentSpecies);
  result.push(...filtered);
  const seen = new Set<string>();
  return result.filter((sp) => {
    if (seen.has(sp.scientificName)) return false;
    seen.add(sp.scientificName);
    return true;
  });
}
import { Button } from "@/components/ui/button";
import { Calendar, ChevronLeft, ChevronRight, Trash2, Play, Pause, SkipBack, SkipForward } from "lucide-react";
import type { Species } from "@/db/schema";
import {
  FftSpectrogram,
  type AudioBoxData,
  type SpectrogramMethods,
} from "./fft-spectrogram";
import {
  SpectrogramControls,
  loadStoredSettings,
  cycleYMax,
  cycleColormap,
  type SpectrogramSettings,
} from "./spectrogram-controls";
import { useAudioAnnotationShortcuts } from "@/hooks/use-audio-annotation-shortcuts";
import {
  createAudioDetection,
  updateAudioDetection,
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
  /** Bbox-level ML confidence (renamed from `confidence` to align with the
   *  shared `AnnotationDetection` shape consumed by `AnnotationToolsSidebar`
   *  and the camera-trap `DetectionWithIdentification`). */
  detectionConfidence: number | null;
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
  frequentSpecies: Species[];
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
  frequentSpecies,
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
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);
  const [sampleRate, setSampleRate] = useState<number | null>(null);
  const [settings, setSettings] = useState<SpectrogramSettings>(() => loadStoredSettings());
  const spectrogramRef = useRef<SpectrogramMethods>(null);

  // Most recently assigned species, scoped per deployment in sessionStorage.
  // Drives the popover "Última" row + the `0` hotkey for repeating across
  // adjacent audio files. Survives file navigation; resets on tab close or
  // deployment switch. Mirrors `fcat:lastSpecies:${jobId}` on camera-trap.
  const lastSpeciesStorageKey = `fcat:lastAudioSpecies:${deploymentId}`;
  const [lastSpeciesName, setLastSpeciesName] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return window.sessionStorage.getItem(lastSpeciesStorageKey);
    } catch {
      return null;
    }
  });

  const speciesMap = useMemo(() => {
    const map = new Map<string, Species>();
    for (const sp of speciesList) map.set(sp.scientificName, sp);
    return map;
  }, [speciesList]);

  const lastSpecies = useMemo(
    () => (lastSpeciesName ? speciesMap.get(lastSpeciesName) ?? null : null),
    [lastSpeciesName, speciesMap]
  );

  // Auto-focus species search when a detection is selected
  useEffect(() => {
    if (selectedDetectionId !== null) {
      searchInputRef.current?.focus();
    } else {
      searchInputRef.current?.blur();
    }
  }, [selectedDetectionId]);

  const audioStreamUrl = driveFileId ? `/api/audio/stream?fileId=${driveFileId}` : null;

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

      setLastSpeciesName(scientificName);
      try {
        window.sessionStorage.setItem(lastSpeciesStorageKey, scientificName);
      } catch {
        // sessionStorage unavailable (private mode / quota) — ignore.
      }

      startTransition(async () => {
        await assignAudioSpecies(det.identification!.id, scientificName);
        router.refresh();
      });
    },
    [selectedDetectionId, detections, router, lastSpeciesStorageKey]
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

  // Playback controls — delegate to spectrogram component via imperative ref
  const handlePlayPause = useCallback(() => {
    spectrogramRef.current?.playPause();
  }, []);

  const handlePlaySelection = useCallback(() => {
    if (!selectedDetection) return;
    spectrogramRef.current?.playSelection(
      selectedDetection.startTime,
      selectedDetection.endTime
    );
  }, [selectedDetection]);

  const handleToggleLoop = useCallback(() => {
    if (!selectedDetection) return;
    const spec = spectrogramRef.current;
    if (!spec) return;
    if (spec.isLooping()) {
      spec.stopLoop();
    } else {
      spec.loopSelection(selectedDetection.startTime, selectedDetection.endTime);
    }
  }, [selectedDetection]);

  const handleJumpToNextUnverified = useCallback(() => {
    if (detections.length === 0) return;
    const sorted = [...detections].sort((a, b) => a.startTime - b.startTime);
    const currentIdx = selectedDetectionId
      ? sorted.findIndex((d) => d.id === selectedDetectionId)
      : -1;
    for (let offset = 1; offset <= sorted.length; offset++) {
      const i = (currentIdx + offset + sorted.length) % sorted.length;
      if (sorted[i].identification?.verificationStatus === "unverified") {
        setSelectedDetectionId(sorted[i].id);
        spectrogramRef.current?.seek(sorted[i].startTime);
        return;
      }
    }
    toast.success("Todas verificadas en este archivo");
  }, [detections, selectedDetectionId]);

  const handleSpectrogramReady = useCallback(
    (meta: { duration: number; sampleRate: number }) => {
      setDuration(meta.duration);
      setSampleRate(meta.sampleRate);
    },
    []
  );

  const handleBoxResized = useCallback(
    (
      boxId: number,
      box: { startTime: number; endTime: number; minFreq: number; maxFreq: number }
    ) => {
      startTransition(async () => {
        await updateAudioDetection(boxId, box);
        router.refresh();
      });
    },
    [router]
  );

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
  const visibleSpecies = getVisibleSpecies(speciesList, frequentSpecies, searchQuery);

  // Keyboard shortcuts
  useAudioAnnotationShortcuts({
    enabled: true,
    onPlayPause: handlePlayPause,
    onSeekBack: () => spectrogramRef.current?.skip(-5),
    onSeekForward: () => spectrogramRef.current?.skip(5),
    onPlaySelection: handlePlaySelection,
    onToggleLoop: handleToggleLoop,
    onJumpToNextUnverified: handleJumpToNextUnverified,
    onCycleYMax: () =>
      setSettings((s) => ({ ...s, displayMaxHz: cycleYMax(s.displayMaxHz, sampleRate) })),
    onCycleColormap: () =>
      setSettings((s) => ({ ...s, colormap: cycleColormap(s.colormap) })),
    onAdjustGain: (delta) =>
      setSettings((s) => ({
        ...s,
        gainDB: Math.max(-20, Math.min(60, s.gainDB + delta)),
      })),
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
      {/* Left sidebar — Species list */}
      <aside className="w-56 shrink-0 flex flex-col min-w-0 overflow-hidden border-r bg-background">
        <SpeciesSidebar
          speciesList={speciesList}
          frequentSpecies={frequentSpecies}
          selectedDetectionId={selectedDetectionId}
          currentSpecies={currentSpecies}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onSelectSpecies={handleSelectSpecies}
          nameDisplay={nameDisplay}
          onCycleDisplay={cycleDisplay}
          searchInputRef={searchInputRef}
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
              {duration != null ? ` (${formatTime(duration)})` : ""}
            </span>
          </div>
        )}

        {/* Spectrogram controls toolbar */}
        {audioStreamUrl && (
          <SpectrogramControls
            settings={settings}
            onChange={setSettings}
            sampleRate={sampleRate}
          />
        )}

        {/* Spectrogram display — client-side FFT renderer */}
        <div className="shrink-0 relative">
          {audioStreamUrl ? (
            <FftSpectrogram
              ref={spectrogramRef}
              audioUrl={audioStreamUrl}
              boxes={boxes}
              selectedBoxId={selectedDetectionId}
              editable={isEditor}
              displayMaxHz={settings.displayMaxHz}
              gainDB={settings.gainDB}
              rangeDB={settings.rangeDB}
              fftSize={settings.fftSize}
              colormap={settings.colormap}
              onBoxClick={(box) =>
                setSelectedDetectionId((prev) =>
                  prev === box.id ? null : box.id
                )
              }
              onDrawComplete={handleDrawComplete}
              onBoxResized={handleBoxResized}
              onReady={handleSpectrogramReady}
              onTimeUpdate={setCurrentTime}
              onPlayPause={setIsPlaying}
            />
          ) : (
            <div className="flex items-center justify-center py-24">
              <p className="text-sm text-muted-foreground">
                Archivo de audio no disponible
              </p>
            </div>
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
                  onClick={() => spectrogramRef.current?.skip(-5)}
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
                  onClick={() => spectrogramRef.current?.skip(5)}
                  title="Avanzar 5s ( ] )"
                >
                  <SkipForward className="h-3.5 w-3.5" />
                </Button>
                <span className="text-xs text-muted-foreground tabular-nums min-w-[4rem]">
                  {formatTime(currentTime)}
                  {duration != null ? ` / ${formatTime(duration)}` : ""}
                </span>
              </>
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
