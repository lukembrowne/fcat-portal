"use client";

import { useState, useTransition, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SpeciesCombobox } from "@/components/species-combobox";
import {
  verifyIdentification,
  rejectIdentification,
  correctIdentification,
} from "@/app/camera-trap/actions";
import type { Species } from "@/db/schema";
import type { AnnotationDetection } from "@/types/annotation";

export interface DetectionWithIdentification extends AnnotationDetection {
  detectionClass: number;
  detectionConfidence: number;
  bboxX: number;
  bboxY: number;
  bboxWidth: number;
  bboxHeight: number;
  identification: {
    id: number;
    species: string;
    confidence: number;
    verificationStatus: string;
    correctedSpecies: string | null;
  } | null;
}

interface AnnotationToolbarProps {
  detections: DetectionWithIdentification[];
  speciesList: Species[];
  frequentSpecies?: Species[];
  selectedDetectionId?: number | null;
  onDetectionSelect?: (detectionId: number) => void;
  onActionComplete?: () => void;
}

const CLASS_LABELS: Record<number, string> = {
  0: "Animal",
  1: "Persona",
  2: "Vehículo",
};

const VERIFICATION_STYLES: Record<string, { variant: "default" | "secondary" | "outline" | "destructive"; label: string }> = {
  unverified: { variant: "outline", label: "Sin verificar" },
  verified: { variant: "default", label: "Verificado" },
  rejected: { variant: "destructive", label: "Rechazado" },
  corrected: { variant: "secondary", label: "Corregido" },
};

export function AnnotationToolbar({
  detections,
  speciesList,
  frequentSpecies = [],
  selectedDetectionId,
  onDetectionSelect,
  onActionComplete,
}: AnnotationToolbarProps) {
  const [isPending, startTransition] = useTransition();
  const [correctingId, setCorrectingId] = useState<number | null>(null);
  const cardRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const handleVerify = useCallback(
    (identificationId: number) => {
      startTransition(async () => {
        await verifyIdentification(identificationId);
        onActionComplete?.();
      });
    },
    [onActionComplete]
  );

  const handleReject = useCallback(
    (identificationId: number) => {
      startTransition(async () => {
        await rejectIdentification(identificationId);
        onActionComplete?.();
      });
    },
    [onActionComplete]
  );

  const handleCorrect = (identificationId: number, newSpecies: string) => {
    setCorrectingId(null); // Optimistic close
    startTransition(async () => {
      const result = await correctIdentification(identificationId, newSpecies);
      if (!result.success) {
        // Re-open if failed
        setCorrectingId(identificationId);
      }
      onActionComplete?.();
    });
  };

  // Scroll selected card into view
  useEffect(() => {
    if (selectedDetectionId != null) {
      const el = cardRefs.current.get(selectedDetectionId);
      el?.scrollIntoView({ block: "nearest", behavior: "instant" });
    }
  }, [selectedDetectionId]);

  if (detections.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground text-center">
        No hay detecciones para anotar.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {detections.map((det, index) => {
        const ident = det.identification;
        if (!ident) return null;

        const isSelected = det.id === selectedDetectionId;
        const isCorrecting = correctingId === ident.id;
        const displaySpecies = ident.correctedSpecies || ident.species;
        const status = VERIFICATION_STYLES[ident.verificationStatus] || VERIFICATION_STYLES.unverified;

        return (
          <div
            key={det.id}
            ref={(el) => {
              if (el) cardRefs.current.set(det.id, el);
              else cardRefs.current.delete(det.id);
            }}
            className={`p-3 border rounded-lg space-y-2 transition-colors cursor-pointer ${
              isSelected ? "ring-2 ring-primary border-primary bg-accent/50" : "hover:bg-accent/30"
            }`}
            onClick={() => onDetectionSelect?.(det.id)}
          >
            <div className="flex items-center justify-between min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <Badge variant="outline" className="text-xs flex-shrink-0 font-mono w-5 h-5 p-0 flex items-center justify-center">
                  {index + 1}
                </Badge>
                <span className="text-sm font-medium truncate">
                  {CLASS_LABELS[det.detectionClass] || "Desconocido"}
                </span>
                <Badge variant="outline" className="text-xs flex-shrink-0">
                  {(det.detectionConfidence * 100).toFixed(0)}%
                </Badge>
              </div>
              <Badge variant={status.variant} className="text-xs flex-shrink-0 ml-2">
                {status.label}
              </Badge>
            </div>

            <div className="flex items-center gap-2 min-w-0">
              <Badge variant="secondary" className="text-xs truncate max-w-[200px]" title={displaySpecies}>
                {displaySpecies}
              </Badge>
              <span className="text-xs text-muted-foreground flex-shrink-0">
                {(ident.confidence * 100).toFixed(0)}%
              </span>
            </div>

            {ident.verificationStatus === "unverified" && (
              <div className="flex items-center gap-2 pt-1">
                <Button
                  size="sm" variant="default" disabled={isPending}
                  onClick={(e) => { e.stopPropagation(); handleVerify(ident.id); }}
                  className="h-7 text-xs"
                >
                  Verificar
                </Button>
                <Button
                  size="sm" variant="destructive" disabled={isPending}
                  onClick={(e) => { e.stopPropagation(); handleReject(ident.id); }}
                  className="h-7 text-xs"
                >
                  Rechazar
                </Button>
                <Button
                  size="sm" variant="outline" disabled={isPending}
                  onClick={(e) => { e.stopPropagation(); setCorrectingId(isCorrecting ? null : ident.id); }}
                  className="h-7 text-xs"
                >
                  Corregir...
                </Button>
              </div>
            )}

            {isCorrecting && (
              <div className="pt-1" onClick={(e) => e.stopPropagation()}>
                <SpeciesCombobox
                  species={speciesList}
                  frequentSpecies={frequentSpecies}
                  onSelect={(scientificName) => handleCorrect(ident.id, scientificName)}
                  disabled={isPending}
                />
              </div>
            )}

            {ident.verificationStatus !== "unverified" && (
              <div className="flex items-center gap-2 pt-1">
                <span className="text-xs text-muted-foreground truncate">
                  {ident.verificationStatus === "corrected" && ident.correctedSpecies
                    ? `Corregido a: ${ident.correctedSpecies}`
                    : `Marcado como ${status.label.toLowerCase()}`}
                </span>
              </div>
            )}
          </div>
        );
      })}

      <div className="text-xs text-muted-foreground text-center pt-2 border-t">
        <span className="font-mono">v</span> verificar &middot;{" "}
        <span className="font-mono">r</span> rechazar &middot;{" "}
        <span className="font-mono">Enter</span> verificar todo &middot;{" "}
        <span className="font-mono">1-9</span> seleccionar &middot;{" "}
        <span className="font-mono">Esc</span> deseleccionar
      </div>
    </div>
  );
}
