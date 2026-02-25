"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  SpeciesSidebar,
  getStoredDisplay,
  DISPLAY_KEY,
  type NameDisplay,
} from "@/components/species-sidebar";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import type { Species } from "@/db/schema";
import type { SpectrogramMetadata } from "@/lib/audio-cache";
import { SpectrogramOverlay, type AudioBoxData } from "./spectrogram-overlay";

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
}: AudioAnnotationClientProps) {
  const router = useRouter();
  const [selectedDetectionId, setSelectedDetectionId] = useState<number | null>(
    null
  );
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [nameDisplay, setNameDisplay] = useState<NameDisplay>(getStoredDisplay);
  const [spectrogramReady, setSpectrogramReady] = useState(false);
  const [spectrogramError, setSpectrogramError] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<SpectrogramMetadata | null>(null);

  const spectrogramUrl = `/api/audio/spectrogram?fileId=${audioFileId}`;

  // Poll for spectrogram readiness
  useEffect(() => {
    let cancelled = false;

    async function checkMeta() {
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
        } else if (data.error) {
          setSpectrogramError(data.error);
        } else {
          // Not ready yet, poll again
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
  }, [audioFileId]);

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
  const boxes: AudioBoxData[] = detections.map((det) => ({
    id: det.id,
    startTime: det.startTime,
    endTime: det.endTime,
    minFreq: det.minFreq,
    maxFreq: det.maxFreq,
    species: det.identification?.correctedSpecies ?? det.identification?.species ?? null,
    verificationStatus: det.identification?.verificationStatus ?? "unverified",
  }));

  const handleSelectSpecies = useCallback(
    (scientificName: string) => {
      // TODO: Phase 4 — wire up species assignment action
      console.log("Species selected:", scientificName, "for detection:", selectedDetectionId);
    },
    [selectedDetectionId]
  );

  const handleDrawComplete = useCallback(
    (box: { startTime: number; endTime: number; minFreq: number; maxFreq: number }) => {
      // TODO: Phase 4 — wire up createAudioDetection action
      console.log("Box drawn:", box);
    },
    []
  );

  // Keyboard navigation
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;

      if (e.code === "ArrowLeft" && prevFileId) {
        e.preventDefault();
        router.push(`/audio/${deploymentId}/annotate/${prevFileId}`);
      } else if (e.code === "ArrowRight" && nextFileId) {
        e.preventDefault();
        router.push(`/audio/${deploymentId}/annotate/${nextFileId}`);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router, deploymentId, prevFileId, nextFileId]);

  return (
    <div className="flex flex-1 min-h-0">
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
        {/* Detection cards strip — TODO: Phase 3 */}
        {detections.length > 0 && (
          <div className="px-4 py-2 border-b shrink-0">
            <div className="flex gap-2 overflow-x-auto">
              {detections.map((det) => (
                <button
                  key={det.id}
                  type="button"
                  onClick={() =>
                    setSelectedDetectionId((prev) =>
                      prev === det.id ? null : det.id
                    )
                  }
                  className={`shrink-0 px-3 py-1.5 rounded border text-xs ${
                    selectedDetectionId === det.id
                      ? "border-primary bg-primary/10"
                      : "border-border hover:bg-accent"
                  }`}
                >
                  {det.startTime.toFixed(1)}s – {det.endTime.toFixed(1)}s
                  {det.identification?.species &&
                    det.identification.species !== "unknown" && (
                      <span className="ml-1 text-muted-foreground">
                        {det.identification.correctedSpecies ??
                          det.identification.species}
                      </span>
                    )}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Spectrogram display */}
        <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden bg-black relative">
          {!spectrogramReady && !spectrogramError && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="flex flex-col items-center gap-3 text-white/70">
                <Loader2 className="h-8 w-8 animate-spin" />
                <p className="text-sm">Generando espectrograma...</p>
              </div>
            </div>
          )}

          {spectrogramError && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="flex flex-col items-center gap-3 text-white/70 max-w-md text-center">
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
            <div className="h-full flex items-center">
              <SpectrogramOverlay
                spectrogramUrl={spectrogramUrl}
                metadata={metadata}
                boxes={boxes}
                selectedBoxId={selectedDetectionId}
                editable={isEditor}
                onBoxClick={(box) =>
                  setSelectedDetectionId((prev) =>
                    prev === box.id ? null : box.id
                  )
                }
                onDrawComplete={handleDrawComplete}
              />
            </div>
          )}
        </div>

        {/* Bottom controls */}
        <div className="px-4 py-2 border-t shrink-0 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {/* Playback controls — TODO: Phase 5 */}
            <span className="text-xs text-muted-foreground">
              {metadata
                ? `${metadata.duration.toFixed(1)}s · ${metadata.sampleRate}Hz · ${metadata.width}×${metadata.height}px`
                : "Cargando..."}
            </span>
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
