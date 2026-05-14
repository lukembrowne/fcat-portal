"use client";

import { useEffect, useMemo, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Trash2, CheckCircle2, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AnnotationDetection } from "@/types/annotation";
import type { Species } from "@/db/schema";
import type { NameDisplay } from "@/lib/species-display";

const CLASS_LABELS: Record<number, string> = {
  0: "Animal",
  1: "Persona",
  2: "Vehículo",
};

const STATUS_COLORS: Record<string, string> = {
  unverified: "bg-gray-400",
  verified: "bg-green-500",
  rejected: "bg-red-500",
  corrected: "bg-blue-500",
};

interface DetectionCardStripProps {
  detections: AnnotationDetection[];
  selectedDetectionId: number | null;
  onSelectDetection: (id: number) => void;
  onDeleteDetection?: (id: number) => void;
  confirmedBlank?: boolean;
  onToggleConfirmedBlank?: () => void;
  nameDisplay?: NameDisplay;
  speciesList?: Species[];
  orientation?: "horizontal" | "vertical";
  /** Audio-only: fired on card mouse enter/leave so the spec can highlight
   *  the corresponding bounding box. Camera-trap omits this prop. */
  onHoverDetection?: (id: number | null) => void;
  /** Audio-only: fired when the play icon on a card is clicked. Camera-trap
   *  omits this prop, so the icon doesn't render. */
  onPlayDetection?: (id: number) => void;
}

export function DetectionCardStrip({
  detections,
  selectedDetectionId,
  onSelectDetection,
  onDeleteDetection,
  confirmedBlank,
  onToggleConfirmedBlank,
  nameDisplay = "scientific",
  speciesList = [],
  orientation = "horizontal",
  onHoverDetection,
  onPlayDetection,
}: DetectionCardStripProps) {
  const isVertical = orientation === "vertical";
  const cardRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  // Build species lookup for display name resolution
  const speciesMap = useMemo(() => {
    const map = new Map<string, Species>();
    for (const sp of speciesList) {
      map.set(sp.scientificName, sp);
    }
    return map;
  }, [speciesList]);

  // Scroll selected card into view
  useEffect(() => {
    if (selectedDetectionId != null) {
      const el = cardRefs.current.get(selectedDetectionId);
      el?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    }
  }, [selectedDetectionId]);

  if (detections.length === 0) {
    return (
      <div className="p-1">
        <div className={cn(
          "flex items-center justify-center gap-2 px-3 border rounded-lg text-sm h-[54px]",
          confirmedBlank
            ? "bg-green-50 border-green-200 text-green-700"
            : "bg-muted/50 text-muted-foreground"
        )}>
        {confirmedBlank ? (
          <>
            <CheckCircle2 className="h-4 w-4" />
            Imagen confirmada como vacía
            {onToggleConfirmedBlank && (
              <button
                type="button"
                onClick={onToggleConfirmedBlank}
                className="ml-2 text-xs underline hover:text-green-900 transition-colors"
              >
                Deshacer
              </button>
            )}
          </>
        ) : (
          <>
            No hay detecciones{onToggleConfirmedBlank && " — clic y arrastrar en la imagen para dibujar un cuadro"}
            {onToggleConfirmedBlank && (
              <button
                type="button"
                onClick={onToggleConfirmedBlank}
                className="ml-2 px-2 py-0.5 text-xs rounded border border-green-300 bg-green-50 text-green-700 hover:bg-green-100 transition-colors"
              >
                Confirmar vacía
              </button>
            )}
          </>
        )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {confirmedBlank && (
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-green-50 border border-green-200 text-green-700 text-xs">
          <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0" />
          Imagen confirmada como vacía — detecciones rechazadas como falsos positivos
        </div>
      )}
      <div
        className={cn(
          "p-1 min-w-0",
          isVertical
            ? "flex flex-col gap-1.5 overflow-y-auto"
            : "flex gap-2 overflow-x-auto"
        )}
      >
      {detections.map((det, index) => {
        const ident = det.identification;
        const isSelected = det.id === selectedDetectionId;
        const scientificName = ident
          ? ident.correctedSpecies || ident.species
          : null;
        let displaySpecies: string;
        if (!scientificName) {
          displaySpecies = "Sin identificar";
        } else if (scientificName === "unknown") {
          displaySpecies = "Sin identificar";
        } else {
          const sp = speciesMap.get(scientificName);
          if (!sp) {
            displaySpecies = scientificName;
          } else {
            switch (nameDisplay) {
              case "common":
                displaySpecies = sp.commonName || sp.scientificName;
                break;
              case "spanish":
                displaySpecies = sp.spanishName || sp.commonName || sp.scientificName;
                break;
              case "scientific":
              default:
                displaySpecies = sp.scientificName;
                break;
            }
          }
        }
        const status = ident?.verificationStatus || "unverified";
        const isHumanVerified = status === "verified" || status === "corrected";
        const confidencePct =
          ident?.confidence != null
            ? ident.confidence
            : det.detectionConfidence != null
              ? det.detectionConfidence
              : null;
        const confidence = confidencePct != null ? (confidencePct * 100).toFixed(0) : null;
        const classLabel =
          det.detectionClass != null ? CLASS_LABELS[det.detectionClass] || "?" : null;
        // Subtitle (e.g. audio's time/freq range) takes precedence over the
        // camera-trap class label. Audio sets subtitle; camera-trap omits it.
        const headerLabel = det.subtitle ?? classLabel;

        return (
          <button
            key={det.id}
            type="button"
            ref={(el) => {
              if (el) cardRefs.current.set(det.id, el);
              else cardRefs.current.delete(det.id);
            }}
            onClick={() => onSelectDetection(det.id)}
            onMouseEnter={onHoverDetection ? () => onHoverDetection(det.id) : undefined}
            onMouseLeave={onHoverDetection ? () => onHoverDetection(null) : undefined}
            className={cn(
              "relative pl-3 pr-2 py-2 border rounded-lg text-left transition-all group overflow-hidden",
              isVertical ? "w-full" : "flex-shrink-0 w-40",
              isSelected
                ? "border-primary bg-primary/10 shadow-md"
                : "hover:bg-accent/30"
            )}
          >
            {/* Left status accent bar */}
            <span
              className={cn(
                "absolute left-0 top-0 bottom-0 w-1",
                STATUS_COLORS[status] || STATUS_COLORS.unverified,
              )}
              aria-hidden
            />

            {/* Header: number + class + confidence + delete */}
            <div className="flex items-center gap-1.5 mb-1">
              <Badge
                variant="outline"
                className="text-[10px] font-mono w-4 h-4 p-0 flex items-center justify-center flex-shrink-0"
              >
                {index + 1}
              </Badge>
              {headerLabel && (
                <span className="text-xs font-medium truncate">
                  {headerLabel}
                </span>
              )}
              {isHumanVerified ? (
                <CheckCircle2
                  className="h-3.5 w-3.5 text-green-600 ml-auto flex-shrink-0"
                  aria-label="Verificado"
                />
              ) : confidence != null ? (
                <span className="text-[10px] text-muted-foreground ml-auto">
                  {confidence}%
                </span>
              ) : null}
              {onPlayDetection && (
                <div
                  role="button"
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    onPlayDetection(det.id);
                  }}
                  className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-accent hover:text-foreground transition-opacity flex-shrink-0 cursor-pointer"
                  title="Reproducir detección"
                  aria-label="Reproducir detección"
                >
                  <Play className="h-3 w-3" />
                </div>
              )}
              {onDeleteDetection && (
                <div
                  role="button"
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteDetection(det.id);
                  }}
                  className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive transition-opacity flex-shrink-0 cursor-pointer"
                  title="Eliminar detección"
                >
                  <Trash2 className="h-3 w-3" />
                </div>
              )}
            </div>

            {/* Species */}
            <div className="min-w-0">
              <span className="text-xs truncate block" title={displaySpecies}>
                {displaySpecies}
              </span>
            </div>
          </button>
        );
      })}
      </div>
    </div>
  );
}
