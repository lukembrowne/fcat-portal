"use client";

import { useState, useTransition, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  verifyIdentification,
  rejectIdentification,
  correctIdentification,
} from "@/app/camera-trap/actions";

export interface DetectionWithIdentification {
  id: number;
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
  speciesList: string[];
  selectedDetectionId?: number | null;
  onDetectionSelect?: (detectionId: number) => void;
  onActionComplete?: () => void;
  enableKeyboardShortcuts?: boolean;
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
  selectedDetectionId,
  onDetectionSelect,
  onActionComplete,
  enableKeyboardShortcuts = true,
}: AnnotationToolbarProps) {
  const [isPending, startTransition] = useTransition();
  const [correctingId, setCorrectingId] = useState<number | null>(null);

  const selectedDetection = detections.find((d) => d.id === selectedDetectionId) || detections[0];

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
    startTransition(async () => {
      await correctIdentification(identificationId, newSpecies);
      setCorrectingId(null);
      onActionComplete?.();
    });
  };

  useEffect(() => {
    if (!enableKeyboardShortcuts) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }

      const det = selectedDetection;
      if (!det?.identification) return;

      if (e.key === "v" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        handleVerify(det.identification.id);
      } else if (e.key === "r" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        handleReject(det.identification.id);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enableKeyboardShortcuts, selectedDetection, handleVerify, handleReject]);

  if (detections.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground text-center">
        No hay detecciones para anotar.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {detections.map((det) => {
        const ident = det.identification;
        if (!ident) return null;

        const isSelected = det.id === selectedDetectionId;
        const isCorrecting = correctingId === ident.id;
        const displaySpecies = ident.correctedSpecies || ident.species;
        const status = VERIFICATION_STYLES[ident.verificationStatus] || VERIFICATION_STYLES.unverified;

        return (
          <div
            key={det.id}
            className={`p-3 border rounded-lg space-y-2 transition-colors cursor-pointer ${
              isSelected ? "border-primary bg-accent/50" : "hover:bg-accent/30"
            }`}
            onClick={() => onDetectionSelect?.(det.id)}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">
                  {CLASS_LABELS[det.detectionClass] || "Desconocido"}
                </span>
                <Badge variant="outline" className="text-xs">
                  {(det.detectionConfidence * 100).toFixed(0)}%
                </Badge>
              </div>
              <Badge variant={status.variant} className="text-xs">
                {status.label}
              </Badge>
            </div>

            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-xs">
                {displaySpecies}
              </Badge>
              <span className="text-xs text-muted-foreground">
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
                  Verificar (v)
                </Button>
                <Button
                  size="sm" variant="destructive" disabled={isPending}
                  onClick={(e) => { e.stopPropagation(); handleReject(ident.id); }}
                  className="h-7 text-xs"
                >
                  Rechazar (r)
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
                <Select onValueChange={(value) => handleCorrect(ident.id, value)}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Seleccionar especie correcta..." />
                  </SelectTrigger>
                  <SelectContent>
                    {speciesList.map((sp) => (
                      <SelectItem key={sp} value={sp} className="text-xs">
                        {sp}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {ident.verificationStatus !== "unverified" && (
              <div className="flex items-center gap-2 pt-1">
                <span className="text-xs text-muted-foreground">
                  {ident.verificationStatus === "corrected" && ident.correctedSpecies
                    ? `Corregido a: ${ident.correctedSpecies}`
                    : `Marcado como ${status.label.toLowerCase()}`}
                </span>
              </div>
            )}
          </div>
        );
      })}

      {enableKeyboardShortcuts && (
        <div className="text-xs text-muted-foreground text-center pt-2 border-t">
          <span className="font-mono">v</span> verificar &middot;{" "}
          <span className="font-mono">r</span> rechazar
        </div>
      )}
    </div>
  );
}
