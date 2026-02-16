"use client";

import { useEffect, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Trash2 } from "lucide-react";
import type { DetectionWithIdentification } from "@/components/annotation-toolbar";

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
}

export function DetectionCardStrip({
  detections,
  selectedDetectionId,
  onSelectDetection,
  onDeleteDetection,
}: DetectionCardStripProps) {
  const cardRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  // Scroll selected card into view
  useEffect(() => {
    if (selectedDetectionId != null) {
      const el = cardRefs.current.get(selectedDetectionId);
      el?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    }
  }, [selectedDetectionId]);

  if (detections.length === 0) {
    return (
      <div className="flex items-center justify-center px-3 py-2 border rounded-lg bg-muted/50 text-sm text-muted-foreground">
        No hay detecciones — clic y arrastrar en la imagen para dibujar un cuadro
      </div>
    );
  }

  return (
    <div className="flex gap-2 overflow-x-auto pb-1 min-w-0">
      {detections.map((det, index) => {
        const ident = det.identification;
        const isSelected = det.id === selectedDetectionId;
        const displaySpecies = ident
          ? ident.correctedSpecies || ident.species
          : "Sin identificar";
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
            className={`relative flex-shrink-0 w-40 p-2 border rounded-lg text-left transition-all group ${
              isSelected
                ? "ring-2 ring-primary border-primary bg-accent/50"
                : "hover:bg-accent/30"
            }`}
          >
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
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteDetection(det.id);
                }}
                className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive transition-opacity flex-shrink-0"
                title="Eliminar detección"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>

            {/* Species + status */}
            <div className="flex items-center gap-1.5 min-w-0">
              <span
                className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_COLORS[status] || STATUS_COLORS.unverified}`}
              />
              <span className="text-xs truncate" title={displaySpecies}>
                {displaySpecies === "unknown" ? "Sin identificar" : displaySpecies}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
