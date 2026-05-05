"use client";

import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Info, BookmarkCheck } from "lucide-react";
import { ImageGrid, type ImageGridItem } from "@/components/image-grid";
import { cn } from "@/lib/utils";
import {
  findLastVerifiedId,
  isVerifiedImage,
  scrollToImageCard,
} from "./resume-helpers";
import {
  SpeciesDisplayProvider,
  useSpeciesDisplay,
  DISPLAY_LABELS,
  type SpeciesNameInfo,
} from "@/lib/species-display";

const COLUMN_OPTIONS = [2, 3, 4, 6] as const;

export interface ResultsSpeciesEntry extends SpeciesNameInfo {
  count: number;
}

interface ResultsClientProps {
  images: ImageGridItem[];
  jobId: number;
  /**
   * Job status from the server. When `pending` or `processing`, the client
   * subscribes to /api/progress and refreshes the page as new detections land.
   * Optional — callers showing a snapshot of a completed job can omit it.
   */
  jobStatus?: string;
  speciesList: ResultsSpeciesEntry[];
  onImageClick?: (imageId: number) => void;
  /**
   * Called whenever the filtered image set changes. Receives the ordered list
   * of filtered image IDs (matching the rendered grid order). Used by parents
   * that need to scope downstream navigation (e.g. annotation overlay) to the
   * currently visible images.
   */
  onFilteredIdsChange?: (ids: number[]) => void;
}

const LIVE_REFRESH_THROTTLE_MS = 2500;

const VERIFICATION_STATUSES = [
  { value: "all", label: "Todos" },
  { value: "unverified", label: "Sin verificar" },
  { value: "verified", label: "Verificado" },
  { value: "rejected", label: "Rechazado" },
];

const PERSON_FILTERS = [
  { value: "all", label: "Todas" },
  { value: "only", label: "Solo personas" },
  { value: "exclude", label: "Sin personas" },
] as const;

type PersonFilter = (typeof PERSON_FILTERS)[number]["value"];

// MegaDetector class index for "person".
const PERSON_CLASS = 1;

const SETUP_FILTERS = [
  { value: "all", label: "Todas" },
  { value: "deployment", label: "Instalación" },
  { value: "retrieval", label: "Recogida" },
  { value: "any", label: "Inst. + Rec." },
] as const;

type SetupFilter = (typeof SETUP_FILTERS)[number]["value"];

export function ResultsClient(props: ResultsClientProps) {
  return (
    <SpeciesDisplayProvider speciesInfo={props.speciesList}>
      <ResultsClientInner {...props} />
    </SpeciesDisplayProvider>
  );
}

function ResultsClientInner({
  images,
  jobId,
  jobStatus,
  speciesList,
  onImageClick,
  onFilteredIdsChange,
}: ResultsClientProps) {
  const router = useRouter();
  const display = useSpeciesDisplay();

  // Live updates while the job is still running. We subscribe to the per-job
  // SSE progress stream that already powers the floating widget and call
  // router.refresh() whenever the processed count climbs — throttled so a fast
  // job doesn't spam SSR re-fetches. router.refresh() preserves filter,
  // scroll, and dialog state, so a verifying user is never interrupted.
  const isLive = jobStatus === "processing" || jobStatus === "pending";
  const lastProcessedRef = useRef(0);
  const lastRefreshAtRef = useRef(0);

  useEffect(() => {
    if (!isLive) return;

    lastProcessedRef.current = 0;
    lastRefreshAtRef.current = 0;

    const source = new EventSource(`/api/progress?jobId=${jobId}`);

    source.onmessage = (event) => {
      let data: {
        processed?: number;
        status?: string;
      };
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }

      if (
        data.status &&
        ["completed", "failed", "cancelled"].includes(data.status)
      ) {
        source.close();
        // Final refresh to surface terminal state + any last detections.
        router.refresh();
        return;
      }

      if (
        typeof data.processed === "number" &&
        data.processed > lastProcessedRef.current
      ) {
        lastProcessedRef.current = data.processed;
        const now = Date.now();
        if (now - lastRefreshAtRef.current >= LIVE_REFRESH_THROTTLE_MS) {
          lastRefreshAtRef.current = now;
          router.refresh();
        }
      }
    };

    return () => {
      source.close();
    };
  }, [isLive, jobId, router]);


  const [gridColumns, setGridColumns] = useState(4);
  useEffect(() => {
    const saved = localStorage.getItem("grid-columns");
    if (saved) setGridColumns(parseInt(saved, 10));
  }, []);
  const handleColumnChange = (cols: number) => {
    setGridColumns(cols);
    localStorage.setItem("grid-columns", String(cols));
  };

  const [selectedSpecies, setSelectedSpecies] = useState<string | null>(null);
  const [verificationFilter, setVerificationFilter] = useState("all");
  const [showEmpty, setShowEmpty] = useState(true);
  const [showStarredOnly, setShowStarredOnly] = useState(false);
  const [showBlanksOnly, setShowBlanksOnly] = useState(false);
  const [personFilter, setPersonFilter] = useState<PersonFilter>("all");
  const [setupFilter, setSetupFilter] = useState<SetupFilter>("all");

  const filteredImages = useMemo(() => {
    return images.filter((img) => {
      if (showStarredOnly && !img.starred) return false;

      if (showBlanksOnly) {
        const isBlank = img.confirmedBlank || img.detections.length === 0;
        if (!isBlank) return false;
      }

      if (selectedSpecies) {
        const hasSpecies = img.detections.some(
          (d) => d.species === selectedSpecies
        );
        if (!hasSpecies) return false;
      }

      if (verificationFilter !== "all") {
        if (img.detections.length === 0) return false;
        const hasStatus = img.detections.some((d) => {
          // "verified" in the UI means any human-reviewed positive
          // identification — both explicit verifications and corrections
          // (where the user changed the ML-predicted species).
          if (verificationFilter === "verified") {
            return (
              d.verificationStatus === "verified" ||
              d.verificationStatus === "corrected"
            );
          }
          return d.verificationStatus === verificationFilter;
        });
        if (!hasStatus) return false;
      }

      if (!showEmpty && img.detections.length === 0) {
        return false;
      }

      if (personFilter !== "all") {
        const hasPerson = img.detections.some(
          (d) => d.detectionClass === PERSON_CLASS
        );
        if (personFilter === "only" && !hasPerson) return false;
        if (personFilter === "exclude" && hasPerson) return false;
      }

      if (setupFilter !== "all") {
        if (setupFilter === "any") {
          if (img.setupTag !== "deployment" && img.setupTag !== "retrieval") {
            return false;
          }
        } else if (img.setupTag !== setupFilter) {
          return false;
        }
      }

      return true;
    });
  }, [images, selectedSpecies, verificationFilter, showEmpty, showStarredOnly, showBlanksOnly, personFilter, setupFilter]);

  // Notify parent of the current ordered filtered ID set so it can scope
  // downstream navigation (e.g. annotation overlay prev/next) to the visible
  // grid. Order matches the rendered grid order.
  useEffect(() => {
    if (!onFilteredIdsChange) return;
    onFilteredIdsChange(filteredImages.map((img) => img.id));
  }, [filteredImages, onFilteredIdsChange]);

  const clearFilters = () => {
    setSelectedSpecies(null);
    setVerificationFilter("all");
    setShowEmpty(true);
    setShowStarredOnly(false);
    setShowBlanksOnly(false);
    setPersonFilter("all");
    setSetupFilter("all");
  };

  const hasActiveFilters =
    selectedSpecies !== null ||
    verificationFilter !== "all" ||
    !showEmpty ||
    showStarredOnly ||
    showBlanksOnly ||
    personFilter !== "all" ||
    setupFilter !== "all";

  // --- Resume ("Continuar donde dejé") ---
  // Computed from the *unfiltered* images so the resume point never depends
  // on the current filter state. We want both the last verified image (the
  // boundary) and whether any unverified images remain (if not, nothing to
  // resume — just hide the button).
  const { resumeTargetId, hasUnverified } = useMemo(() => {
    const target = findLastVerifiedId(images);
    const anyUnverified = images.some((img) => !isVerifiedImage(img));
    return { resumeTargetId: target, hasUnverified: anyUnverified };
  }, [images]);

  const canResume = resumeTargetId != null && hasUnverified;

  const handleResume = useCallback(() => {
    if (resumeTargetId == null) return;
    // Reset filters first so the target card is guaranteed to be in the
    // rendered DOM. scrollToImageCard waits a frame for the re-render.
    if (hasActiveFilters) clearFilters();
    void scrollToImageCard(resumeTargetId);
  }, [resumeTargetId, hasActiveFilters]);

  // Keyboard shortcut: 'r' to resume. Ignored when focus is in a text input
  // or textarea (so it doesn't fight with typing), or while any modifier key
  // is pressed (so browser shortcuts like Ctrl-R reload still work).
  useEffect(() => {
    if (!canResume) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "r" && e.key !== "R") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        (target?.isContentEditable ?? false)
      ) {
        return;
      }
      e.preventDefault();
      handleResume();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [canResume, handleResume]);

  return (
    <div className="space-y-3">
      {isLive && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
          <span>En vivo · esta página se actualiza automáticamente mientras se procesa</span>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-[210px_1fr]">
      {/* Filter Sidebar */}
      <div className="space-y-3">
        <Card className="gap-0 py-0">
          <CardHeader className="pb-2 pt-3 px-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm inline-flex items-center gap-1.5">
                Filtros
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button type="button" className="inline-flex items-center text-muted-foreground hover:text-foreground">
                        <Info className="h-3.5 w-3.5" />
                        <span className="sr-only">Ayuda sobre los filtros</span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-xs bg-popover text-popover-foreground border shadow-md p-3">
                      <div className="flex flex-col gap-1.5 text-xs">
                        <p><strong>Especie:</strong> muestra solo imágenes con la especie seleccionada.</p>
                        <p><strong>Verificación:</strong> filtra por estado de revisión (sin verificar, verificado, rechazado).</p>
                        <p><strong>Mostrar imágenes sin detecciones:</strong> incluye fotos donde el ML no detectó nada.</p>
                        <p><strong>Solo destacadas:</strong> muestra solo las imágenes marcadas con estrella.</p>
                        <p><strong>Solo vacías:</strong> muestra únicamente las fotos sin detecciones.</p>
                        <p><strong>Personas:</strong> filtra imágenes con o sin presencia humana.</p>
                        <p><strong>Inst. / Recogida:</strong> filtra por imágenes de instalación o recogida del sensor.</p>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </CardTitle>
              {hasActiveFilters && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs h-auto py-0.5 px-1.5"
                  onClick={clearFilters}
                >
                  Limpiar
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-3 px-3 pb-3">
            {speciesList.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">
                    Especie{" "}
                    <span className="text-muted-foreground/70 normal-case tracking-normal">
                      ({speciesList.length})
                    </span>
                  </Label>
                  {display && (
                    <button
                      type="button"
                      onClick={display.cycle}
                      className="text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded border transition-colors"
                      title="Cambiar formato de nombre"
                    >
                      {DISPLAY_LABELS[display.nameDisplay]}
                    </button>
                  )}
                </div>
                <div className="relative rounded-md border bg-background/40">
                  <div
                    className="space-y-1 max-h-56 overflow-y-auto p-1 [scrollbar-width:thin]"
                    style={{ scrollbarGutter: "stable" }}
                  >
                    {speciesList.map((sp) => {
                      const label = display ? display.getName(sp.scientificName) : sp.scientificName;
                      return (
                        <button
                          key={sp.scientificName}
                          className={cn(
                            "flex items-center justify-between w-full text-left px-1.5 py-1 rounded text-xs hover:bg-accent transition-colors",
                            selectedSpecies === sp.scientificName && "bg-accent font-medium"
                          )}
                          onClick={() =>
                            setSelectedSpecies((prev) =>
                              prev === sp.scientificName ? null : sp.scientificName
                            )
                          }
                          title={sp.scientificName}
                        >
                          <span
                            className={cn(
                              "truncate",
                              display?.nameDisplay === "scientific" && "italic",
                            )}
                          >
                            {label}
                          </span>
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 ml-2 shrink-0">
                            {sp.count}
                          </Badge>
                        </button>
                      );
                    })}
                  </div>
                  {/* Bottom fade — visible only when content overflows; harmless on short lists */}
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 rounded-b-md bg-gradient-to-t from-card to-transparent" />
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">
                Verificación
              </Label>
              <div className="flex flex-wrap gap-1">
                {VERIFICATION_STATUSES.map((s) => (
                  <button
                    key={s.value}
                    className={cn(
                      "px-1.5 py-0.5 text-[11px] rounded-md border transition-colors",
                      verificationFilter === s.value
                        ? "bg-primary text-primary-foreground border-primary"
                        : "hover:bg-accent border-border"
                    )}
                    onClick={() => setVerificationFilter(s.value)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={showEmpty}
                onChange={(e) => setShowEmpty(e.target.checked)}
                className="accent-primary"
              />
              Mostrar imágenes sin detecciones
            </label>

            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={showStarredOnly}
                onChange={(e) => setShowStarredOnly(e.target.checked)}
                className="accent-primary"
              />
              Solo destacadas
            </label>

            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={showBlanksOnly}
                onChange={(e) => setShowBlanksOnly(e.target.checked)}
                className="accent-primary"
              />
              Solo vacías (sin detecciones)
            </label>

            <div className="space-y-1.5">
              <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">
                Personas
              </Label>
              <div className="flex flex-wrap gap-1">
                {PERSON_FILTERS.map((f) => (
                  <button
                    key={f.value}
                    className={cn(
                      "px-1.5 py-0.5 text-[11px] rounded-md border transition-colors",
                      personFilter === f.value
                        ? "bg-primary text-primary-foreground border-primary"
                        : "hover:bg-accent border-border"
                    )}
                    onClick={() => setPersonFilter(f.value)}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">
                Inst. / Recogida
              </Label>
              <div className="flex flex-wrap gap-1">
                {SETUP_FILTERS.map((f) => (
                  <button
                    key={f.value}
                    className={cn(
                      "px-1.5 py-0.5 text-[11px] rounded-md border transition-colors",
                      setupFilter === f.value
                        ? "bg-primary text-primary-foreground border-primary"
                        : "hover:bg-accent border-border"
                    )}
                    onClick={() => setSetupFilter(f.value)}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

          </CardContent>
        </Card>
      </div>

      {/* Image Grid */}
      <div>
        <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
          <h2 className="text-lg font-semibold">
            Imágenes ({filteredImages.length}
            {filteredImages.length !== images.length &&
              ` de ${images.length}`}
            )
          </h2>
          <div className="flex items-center gap-2">
            {canResume && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleResume}
                className="gap-1.5"
                title="Atajo: R"
                aria-label="Continuar donde dejé: saltar a la última imagen verificada"
              >
                <BookmarkCheck className="h-4 w-4" />
                Continuar donde dejé
              </Button>
            )}
            <div className="flex items-center gap-1 border rounded-md p-0.5">
              {COLUMN_OPTIONS.map((cols) => (
                <button
                  key={cols}
                  className={cn(
                    "px-2 py-1 text-xs rounded transition-colors",
                    gridColumns === cols
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-accent"
                  )}
                  onClick={() => handleColumnChange(cols)}
                  title={`${cols} columnas`}
                >
                  {cols}
                </button>
              ))}
            </div>
          </div>
        </div>
        <ImageGrid
          images={filteredImages}
          jobId={jobId}
          columns={gridColumns}
          onImageClick={onImageClick}
        />
      </div>

      </div>
    </div>
  );
}
