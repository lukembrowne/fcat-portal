"use client";

import Link from "next/link";
import { Camera, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DetectionCardStrip } from "@/components/detection-card-strip";
import { AnnotationHelpPanel } from "@/components/annotation-help-panel";
import type { AnnotationDetection } from "@/types/annotation";
import type { Species } from "@/db/schema";
import type { NameDisplay } from "@/components/species-sidebar";

const DISPLAY_LABELS: Record<NameDisplay, string> = {
  common: "Inglés",
  spanish: "Español",
  scientific: "Científico",
};

interface AnnotationToolsSidebarProps {
  detections: AnnotationDetection[];
  selectedDetectionId: number | null;
  onSelectDetection: (id: number) => void;
  onDeleteDetection?: (id: number) => void;
  confirmedBlank: boolean;
  onToggleConfirmedBlank?: () => void;
  speciesList: Species[];
  nameDisplay: NameDisplay;
  onCycleDisplay: () => void;
  canEdit: boolean;
  setupTag: "deployment" | "retrieval" | null;
  onToggleSetupDeployment?: () => void;
  onToggleSetupRetrieval?: () => void;
  isStarred: boolean;
  starredBy: string | null;
  onToggleStarred?: () => void;
  dateSuggestion: {
    field: "validStart" | "validEnd";
    value: string;
  } | null;
  onApplyDateSuggestion?: () => void;
  onDismissDateSuggestion?: () => void;
  jobId: number;
  onBack?: () => void;
}

export function AnnotationToolsSidebar({
  detections,
  selectedDetectionId,
  onSelectDetection,
  onDeleteDetection,
  confirmedBlank,
  onToggleConfirmedBlank,
  speciesList,
  nameDisplay,
  onCycleDisplay,
  canEdit,
  setupTag,
  onToggleSetupDeployment,
  onToggleSetupRetrieval,
  isStarred,
  starredBy,
  onToggleStarred,
  dateSuggestion,
  onApplyDateSuggestion,
  onDismissDateSuggestion,
  jobId,
  onBack,
}: AnnotationToolsSidebarProps) {
  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Detecciones */}
      <div className="px-2 pt-2 pb-2 border-b">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">Detecciones</h3>
          <button
            type="button"
            onClick={onCycleDisplay}
            className="text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded border transition-colors"
            title="Cambiar formato de nombre"
          >
            {DISPLAY_LABELS[nameDisplay]}
          </button>
        </div>
        <BlankToggle
          confirmedBlank={confirmedBlank}
          onToggleConfirmedBlank={onToggleConfirmedBlank}
        />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <DetectionCardStrip
          orientation="vertical"
          detections={detections}
          selectedDetectionId={selectedDetectionId}
          onSelectDetection={onSelectDetection}
          onDeleteDetection={onDeleteDetection}
          confirmedBlank={confirmedBlank}
          onToggleConfirmedBlank={undefined}
          nameDisplay={nameDisplay}
          speciesList={speciesList}
        />
      </div>

      {/* Acciones de imagen */}
      {canEdit && (
        <div className="px-2 py-2 border-t flex flex-col gap-1.5">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-1">
            Acciones
          </p>
          <button
            type="button"
            onClick={onToggleStarred}
            title={isStarred && starredBy ? `Destacada por ${starredBy}` : "Destacar imagen (s)"}
            className={cn(
              "w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md border text-sm transition-colors",
              isStarred
                ? "bg-amber-500 border-amber-500 text-white hover:bg-amber-600"
                : "border-border hover:bg-amber-50 hover:border-amber-200 hover:text-amber-700"
            )}
          >
            <StarIcon filled={isStarred} className="size-4 shrink-0" />
            <span className="truncate">{isStarred ? "Destacada" : "Destacar"}</span>
          </button>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              onClick={onToggleSetupDeployment}
              title="Marcar como instalación (i)"
              className={cn(
                "flex flex-col items-center justify-center gap-1 px-2 py-2 rounded-md border text-xs transition-colors",
                setupTag === "deployment"
                  ? "bg-blue-600 border-blue-600 text-white hover:bg-blue-700"
                  : "border-border hover:bg-blue-50 hover:border-blue-200 hover:text-blue-700"
              )}
            >
              <Camera className="size-4 shrink-0" />
              Instalación
            </button>
            <button
              type="button"
              onClick={onToggleSetupRetrieval}
              title="Marcar como recogida (t)"
              className={cn(
                "flex flex-col items-center justify-center gap-1 px-2 py-2 rounded-md border text-xs transition-colors",
                setupTag === "retrieval"
                  ? "bg-orange-600 border-orange-600 text-white hover:bg-orange-700"
                  : "border-border hover:bg-orange-50 hover:border-orange-200 hover:text-orange-700"
              )}
            >
              <Camera className="size-4 shrink-0" />
              Recogida
            </button>
          </div>
          {dateSuggestion && (
            <DateSuggestionCard
              suggestion={dateSuggestion}
              onApply={onApplyDateSuggestion}
              onDismiss={onDismissDateSuggestion}
            />
          )}
        </div>
      )}

      {/* Ayuda */}
      <div className="px-2 py-2 border-t">
        <AnnotationHelpPanel />
      </div>

      {/* Volver */}
      <div className="px-2 py-2 border-t">
        {onBack ? (
          <Button variant="outline" size="sm" className="w-full" onClick={onBack}>
            Volver a Cuadrícula
          </Button>
        ) : (
          <Button asChild variant="outline" size="sm" className="w-full">
            <Link href={`/camera-trap/results/${jobId}`} scroll={false}>
              Volver a Cuadrícula
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}

function StarIcon({ filled, className }: { filled: boolean; className?: string }) {
  return (
    <svg
      className={className}
      fill={filled ? "currentColor" : "none"}
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z"
      />
    </svg>
  );
}

function DateSuggestionCard({
  suggestion,
  onApply,
  onDismiss,
}: {
  suggestion: { field: "validStart" | "validEnd"; value: string };
  onApply?: () => void;
  onDismiss?: () => void;
}) {
  const fieldLabel =
    suggestion.field === "validStart" ? "fecha de inicio válida" : "fecha de fin válida";
  return (
    <div className="rounded-md border border-blue-300 bg-blue-50 px-2.5 py-2 text-xs text-blue-900 space-y-1.5 shadow-sm">
      <div className="font-medium">¿Usar este timestamp como {fieldLabel}?</div>
      <div className="font-mono text-[11px] text-blue-800">
        {suggestion.value.replace("T", " ")}
      </div>
      <div className="flex gap-1.5 pt-0.5">
        <Button
          variant="default"
          size="sm"
          className="h-6 px-2 text-[11px] flex-1 bg-blue-600 hover:bg-blue-700"
          onClick={onApply}
        >
          Aplicar
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[11px] text-blue-800 hover:bg-blue-100"
          onClick={onDismiss}
        >
          Cerrar
        </Button>
      </div>
    </div>
  );
}

function BlankToggle({
  confirmedBlank,
  onToggleConfirmedBlank,
}: {
  confirmedBlank: boolean;
  onToggleConfirmedBlank?: () => void;
}) {
  if (!onToggleConfirmedBlank) {
    return null;
  }
  return (
    <button
      type="button"
      onClick={onToggleConfirmedBlank}
      className={cn(
        "w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs rounded border transition-colors",
        confirmedBlank
          ? "bg-green-50 border-green-200 text-green-700 hover:bg-green-100"
          : "bg-muted/30 border-border text-muted-foreground hover:bg-accent/50"
      )}
      title="Confirmar/desconfirmar imagen vacía (b)"
    >
      <CheckCircle2 className="h-3.5 w-3.5" />
      {confirmedBlank ? "Imagen confirmada vacía" : "Confirmar imagen vacía"}
    </button>
  );
}
