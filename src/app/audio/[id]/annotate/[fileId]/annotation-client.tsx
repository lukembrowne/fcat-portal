"use client";

import { useState, useCallback, useEffect, useMemo, useRef, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { useNameDisplay, type NameDisplay } from "@/lib/species-display";
import { AnnotationToolsSidebar } from "@/components/annotation-tools-sidebar";
import { AnnotationPickerPopover } from "@/components/annotation-picker-popover";
import { Popover, PopoverAnchor } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Calendar, ChevronLeft, ChevronRight, Download, Play, Pause, SkipBack, SkipForward } from "lucide-react";
import type { Species } from "@/db/schema";
import {
  FftSpectrogram,
  type AudioBoxData,
  type SpectrogramMethods,
  type SpecMeasurement,
} from "./fft-spectrogram";
import {
  SpectrogramControls,
  loadStoredSettings,
  cycleYMax,
  cycleColormap,
  type SpectrogramSettings,
} from "./spectrogram-controls";
import { AnnotationFilterBar } from "@/components/audio/annotation-filter-bar";
import {
  FREQ_AXIS_WIDTH,
  anchorBoxToViewportPx,
  anchorInViewport,
} from "@/lib/spectrogram-layout";
import { useAnnotationShortcuts } from "@/hooks/use-annotation-shortcuts";
import { useAudioPlaybackShortcuts } from "@/hooks/use-audio-playback-shortcuts";
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
  showAll: boolean;
  /** Optional initial seek position (seconds), passed via `?seek=`. Applied
   *  once after the spectrogram reports duration. */
  initialSeek?: number | null;
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
  showAll,
  initialSeek,
}: AudioAnnotationClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Preserve filter context (?conf= / ?showAll=) when navigating between files.
  const buildSiblingUrl = useCallback(
    (targetFileId: number) => {
      const params = new URLSearchParams();
      const conf = searchParams.get("conf");
      const showAllParam = searchParams.get("showAll");
      if (conf) params.set("conf", conf);
      if (showAllParam) params.set("showAll", showAllParam);
      const qs = params.toString();
      const base = `/audio/${deploymentId}/annotate/${targetFileId}`;
      return qs ? `${base}?${qs}` : base;
    },
    [deploymentId, searchParams]
  );
  const [selectedDetectionId, setSelectedDetectionId] = useState<number | null>(
    null
  );
  // Cross-component hover: sidebar card → bbox halo. Distinct from
  // `hoverBoxId` inside FftSpectrogram (direct SVG hover); the two are OR-ed
  // on the spec side so either source highlights the same box.
  const [hoveredDetectionId, setHoveredDetectionId] = useState<number | null>(
    null
  );
  const popoverSearchInputRef = useRef<HTMLInputElement>(null);
  const spectrogramContainerRef = useRef<HTMLDivElement>(null);
  const [nameDisplay, cycleDisplay] = useNameDisplay();
  const [, startTransition] = useTransition();
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);
  const [sampleRate, setSampleRate] = useState<number | null>(null);
  const [settings, setSettings] = useState<SpectrogramSettings>(() => loadStoredSettings());
  const [measurements, setMeasurements] = useState<SpecMeasurement>({
    viewportWidth: 0,
    scrollWidth: 0,
    specHeight: 0,
  });
  const [scrollLeft, setScrollLeft] = useState(0);
  // Bumped on every card-click to retrigger the pulse animation on the
  // selected box. The actual id sits in `selectedDetectionId`; this counter
  // is the React-friendly invalidator (per the plan, NOT a timestamp).
  const [pulseKey, setPulseKey] = useState(0);
  const spectrogramRef = useRef<SpectrogramMethods>(null);

  // Project-wide hotkey slots (1-9), locked at page load to match camera-trap
  // semantics. The popover binds slot index → scientific name; the chrome
  // shortcuts hook fans 1-9 keystrokes to `onAssignSpeciesByIndex(index)`.
  const stableHotkeySlots = useMemo(
    () => frequentSpecies.slice(0, 9),
    [frequentSpecies]
  );

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

  const audioStreamUrl = driveFileId ? `/api/audio/stream?fileId=${driveFileId}` : null;

  const selectedDetection = detections.find(
    (d) => d.id === selectedDetectionId
  );

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

  // Attach a time/freq subtitle so the shared detection card shows the
  // audio-specific context (e.g. "0.5s–2.3s · 1.2–8.0 kHz") in the
  // header position camera-trap uses for the class label.
  const detectionsForSidebar = detections.map((det) => ({
    ...det,
    subtitle:
      `${det.startTime.toFixed(1)}s–${det.endTime.toFixed(1)}s · ` +
      `${(det.minFreq / 1000).toFixed(1)}–${(det.maxFreq / 1000).toFixed(1)} kHz`,
  }));

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

  // Picker adapter callbacks. The shared popover doesn't know about audio's
  // identificationId / detectionId distinction — it just calls these.
  const handleAssignSpeciesByIndex = useCallback(
    (index: number) => {
      if (index < stableHotkeySlots.length) {
        handleSelectSpecies(stableHotkeySlots[index].scientificName);
      }
    },
    [stableHotkeySlots, handleSelectSpecies]
  );

  const handleAssignLastSpecies = useCallback(() => {
    if (lastSpecies) handleSelectSpecies(lastSpecies.scientificName);
  }, [lastSpecies, handleSelectSpecies]);

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

  // Sidebar card play-button: seek + unbounded play. Distinct from
  // `handlePlaySelection` (the bottom "Reproducir selección" button + `p`
  // shortcut), which uses `playSelection` to auto-stop at the detection
  // end. Per user preference, the card button plays past the detection.
  const handlePlayDetection = useCallback(
    (id: number) => {
      const det = detections.find((d) => d.id === id);
      if (!det) return;
      spectrogramRef.current?.seek(det.startTime);
      void spectrogramRef.current?.play();
    },
    [detections]
  );

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

  const initialSeekAppliedRef = useRef(false);
  const handleSpectrogramReady = useCallback(
    (meta: { duration: number; sampleRate: number }) => {
      setDuration(meta.duration);
      setSampleRate(meta.sampleRate);
      // URL `?seek=` wins on first navigation only — applied once after the
      // spectrogram reports duration so we can clamp the value.
      if (
        initialSeek != null &&
        Number.isFinite(initialSeek) &&
        !initialSeekAppliedRef.current
      ) {
        initialSeekAppliedRef.current = true;
        const clamped = Math.min(Math.max(initialSeek, 0), meta.duration);
        spectrogramRef.current?.seek(clamped);
        spectrogramRef.current?.scrollToTime(clamped);
      }
    },
    [initialSeek]
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
        router.push(buildSiblingUrl(result.data.nextFileId));
      } else {
        router.refresh();
      }
    });
  }, [detections, deploymentId, audioFileId, router, buildSiblingUrl]);

  // Auto-scroll the spectrogram to the selected box and trigger the pulse
  // animation. Fires on every selection change (sidebar card click,
  // keyboard hotkey, spectrogram box click). If the box is already in
  // view, smooth-scroll is a no-op; the pulse still plays.
  useEffect(() => {
    if (selectedDetectionId == null) return;
    const det = detections.find((d) => d.id === selectedDetectionId);
    if (!det) return;
    const center = (det.startTime + det.endTime) / 2;
    spectrogramRef.current?.scrollToTime(center);
    // Bump the pulse counter so the spectrogram retriggers the keyframe. The
    // counter has no derived state — it's just a render token — so the
    // set-state-in-effect rule is overly cautious here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPulseKey((k) => k + 1);
  }, [selectedDetectionId, detections]);

  // Derived picker state. The popover opens whenever a detection is selected
  // (mirrors camera-trap's useAnnotationPicker gate without zoom/dialog state).
  const pickerOpen = selectedDetectionId !== null;
  const currentSpeciesForPicker =
    selectedDetection?.identification?.correctedSpecies ??
    selectedDetection?.identification?.species ??
    null;
  const selectedDetectionForPicker = selectedDetection
    ? {
        id: selectedDetection.id,
        detectionConfidence: selectedDetection.detectionConfidence,
        identification: selectedDetection.identification,
      }
    : null;
  const selectedDetectionNumber = selectedDetectionId
    ? detections.findIndex((d) => d.id === selectedDetectionId) + 1
    : 0;

  // Anchor pixel rect for the popover. Computed from the spec's current
  // measurements + scroll offset via the pure `anchorBoxToViewportPx`
  // helper (single source of truth — was duplicated here before Phase 2).
  // Closes the popover when the anchor scrolls off the visible viewport.
  const anchorStyle = useMemo(() => {
    if (
      !selectedDetection ||
      !duration ||
      duration <= 0 ||
      measurements.viewportWidth <= 0 ||
      measurements.specHeight <= 0
    ) {
      return null;
    }
    const anchor = anchorBoxToViewportPx(selectedDetection, {
      duration,
      scrollLeft,
      scrollWidth: measurements.scrollWidth,
      viewportWidth: measurements.viewportWidth,
      specHeight: measurements.specHeight,
      displayMaxHz: settings.displayMaxHz,
    });
    if (!anchorInViewport(anchor, measurements.viewportWidth)) return null;
    return {
      left: FREQ_AXIS_WIDTH + anchor.x,
      top: anchor.y,
      width: anchor.w,
      height: anchor.h,
    };
  }, [selectedDetection, duration, measurements, scrollLeft, settings.displayMaxHz]);

  // Keyboard shortcuts — split between shared chrome and audio playback.
  useAnnotationShortcuts({
    enabled: true,
    onQuickVerifyAll: handleQuickVerifyAll,
    onNext: () => {
      if (nextFileId) router.push(buildSiblingUrl(nextFileId));
    },
    onPrev: () => {
      if (prevFileId) router.push(buildSiblingUrl(prevFileId));
    },
    onSelectDetection: (index) => {
      if (index < detections.length) {
        setSelectedDetectionId(detections[index].id);
      }
    },
    onDeselect: () => setSelectedDetectionId(null),
    onDeleteSelected: () => {
      if (selectedDetectionId) handleDeleteDetection(selectedDetectionId);
    },
    onAssignSpeciesByIndex: handleAssignSpeciesByIndex,
    onAssignLastSpecies: handleAssignLastSpecies,
    detectionCount: detections.length,
    selectedDetectionId,
    isPickerOpen: pickerOpen,
    searchInputRef: popoverSearchInputRef,
  });

  useAudioPlaybackShortcuts({
    enabled: true,
    onPlayPause: handlePlayPause,
    onSeekBack: () => spectrogramRef.current?.skip(-5),
    onSeekForward: () => spectrogramRef.current?.skip(5),
    onPlaySelection: handlePlaySelection,
    onToggleLoop: handleToggleLoop,
    onJumpToNextUnverified: handleJumpToNextUnverified,
    onVerify: handleVerifySelected,
    onReject: handleRejectSelected,
    onCycleYMax: () =>
      setSettings((s) => ({ ...s, displayMaxHz: cycleYMax(s.displayMaxHz, sampleRate) })),
    onCycleColormap: () =>
      setSettings((s) => ({ ...s, colormap: cycleColormap(s.colormap) })),
    onAdjustGain: (delta) =>
      setSettings((s) => ({
        ...s,
        gainDB: Math.max(-20, Math.min(60, s.gainDB + delta)),
      })),
    isPickerOpen: pickerOpen,
    searchInputRef: popoverSearchInputRef,
  });

  return (
    <Popover
      open={pickerOpen}
      onOpenChange={(next) => {
        if (!next) setSelectedDetectionId(null);
      }}
    >
      <div className="flex flex-1 min-h-0">
        {/* Left sidebar — detections + tools (shared with camera-trap) */}
        <aside className="w-56 shrink-0 flex flex-col min-w-0 overflow-hidden border-r bg-background">
          <AnnotationToolsSidebar
            detections={detectionsForSidebar}
            selectedDetectionId={selectedDetectionId}
            onSelectDetection={(id) =>
              setSelectedDetectionId((prev) => (prev === id ? null : id))
            }
            onHoverDetection={setHoveredDetectionId}
            onPlayDetection={handlePlayDetection}
            onDeleteDetection={isEditor ? handleDeleteDetection : undefined}
            confirmedBlank={false}
            speciesList={speciesList}
            nameDisplay={nameDisplay}
            onCycleDisplay={cycleDisplay}
            canEdit={isEditor}
            setupTag={null}
            isStarred={false}
            starredBy={null}
            dateSuggestion={null}
            jobId={deploymentId}
            onBack={() => router.push(`/audio/${deploymentId}`)}
          />
        </aside>

        {/* Main content */}
        <div className="flex-1 flex flex-col min-w-0">
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

        {/* Spectrogram controls toolbar — also hosts the confidence
            threshold slider and "show all" toggle, slotted inline at the end. */}
        {audioStreamUrl && (
          <SpectrogramControls
            settings={settings}
            onChange={setSettings}
            sampleRate={sampleRate}
            trailing={<AnnotationFilterBar showAll={showAll} />}
          />
        )}

        {/* Spectrogram display — client-side FFT renderer.
            Fills the remaining vertical space between the controls bar and
            the playback controls. `relative` so the PopoverAnchor positions
            correctly over the selected box. */}
        <div ref={spectrogramContainerRef} className="flex-1 min-h-0 relative">
          {audioStreamUrl ? (
            <FftSpectrogram
              ref={spectrogramRef}
              audioUrl={audioStreamUrl}
              boxes={boxes}
              selectedBoxId={selectedDetectionId}
              hoveredBoxId={hoveredDetectionId}
              editable={isEditor}
              displayMaxHz={settings.displayMaxHz}
              gainDB={settings.gainDB}
              rangeDB={settings.rangeDB}
              fftSize={settings.fftSize}
              colormap={settings.colormap}
              zoomLevel={settings.zoomLevel}
              followPlayback={settings.followPlayback}
              detectionsVersion={detections.length}
              pulseKey={pulseKey}
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
              onMeasurementsChange={setMeasurements}
              onScrollChange={setScrollLeft}
              onZoomChange={(next) =>
                setSettings((s) => ({ ...s, zoomLevel: next }))
              }
            />
          ) : (
            <div className="flex items-center justify-center py-24">
              <p className="text-sm text-muted-foreground">
                Archivo de audio no disponible
              </p>
            </div>
          )}

          {/* Invisible anchor sized/positioned to the selected box.
              Radix attaches the popover to this element; AnnotationPickerPopover
              uses sideOffset>0 so the popover never overlaps the box. */}
          {anchorStyle && (
            <PopoverAnchor asChild>
              <div
                className="absolute pointer-events-none"
                style={anchorStyle}
              />
            </PopoverAnchor>
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
                {driveFileId && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    asChild
                    title="Descargar archivo"
                  >
                    <a
                      href={`/api/audio/stream?fileId=${encodeURIComponent(driveFileId)}&download=true`}
                      download
                    >
                      <Download className="h-3.5 w-3.5" />
                    </a>
                  </Button>
                )}
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
                <Link href={buildSiblingUrl(prevFileId)}>
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
                <Link href={buildSiblingUrl(nextFileId)}>
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

      {/* Contextual picker — anchored to the selected box on the spectrogram.
          Lives inside the Popover root so PopoverAnchor governs its position. */}
      <AnnotationPickerPopover
        open={pickerOpen}
        selectedDetection={selectedDetectionForPicker}
        detectionNumber={selectedDetectionNumber}
        currentSpecies={currentSpeciesForPicker}
        hotkeySlots={stableHotkeySlots}
        lastSpecies={lastSpecies}
        speciesList={speciesList}
        nameDisplay={nameDisplay}
        canEdit={isEditor}
        containerRef={spectrogramContainerRef}
        searchInputRef={popoverSearchInputRef}
        onAssignSpecies={handleSelectSpecies}
        onAssignSpeciesByIndex={handleAssignSpeciesByIndex}
        onAssignLastSpecies={handleAssignLastSpecies}
        onDelete={() => {
          if (selectedDetectionId != null) handleDeleteDetection(selectedDetectionId);
        }}
      />
    </Popover>
  );
}
