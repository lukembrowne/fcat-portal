"use client";

import { useEffect, useMemo, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Trash2, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DetectionWithIdentification } from "@/components/annotation-toolbar";
import type { Species } from "@/db/schema";
import type { NameDisplay } from "@/components/species-sidebar";

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
  detections: DetectionWithIdentification[];
  selectedDetectionId: number | null;
  onSelectDetection: (id: number) => void;
  onDeleteDetection: (id: number) => void;
  confirmedBlank?: boolean;
  onToggleConfirmedBlank?: () => void;
  nameDisplay?: NameDisplay;
  speciesList?: Species[];
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
}: DetectionCardStripProps) {
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
      <div className={cn(
        "flex items-center justify-center gap-2 px-3 py-2 border rounded-lg text-sm",
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
            No hay detecciones — clic y arrastrar en la imagen para dibujar un cuadro
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
      <div className="flex gap-2 overflow-x-auto p-1 min-w-0">
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
        const confidence = ident
          ? (ident.confidence * 100).toFixed(0)
          : (det.detectionConfidence * 100).toFixed(0);

        return (
          <button
            key={det.id}
            type="button"
            ref={(el) => {
              if (el) cardRefs.current.set(det.id, el);
              else cardRefs.current.delete(det.id);
            }}
            onClick={() => onSelectDetection(det.id)}
            className={cn(
              "relative flex-shrink-0 w-40 pl-3 pr-2 py-2 border rounded-lg text-left transition-all group overflow-hidden",
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
              <span className="text-xs font-medium truncate">
                {CLASS_LABELS[det.detectionClass] || "?"}
              </span>
              <span className="text-[10px] text-muted-foreground ml-auto">
                {confidence}%
              </span>
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
