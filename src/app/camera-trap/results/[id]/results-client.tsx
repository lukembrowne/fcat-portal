"use client";

import { useState, useMemo, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ImageGrid, type ImageGridItem } from "@/components/image-grid";
import { BatchDeleteImagesDialog } from "@/app/camera-trap/batch-delete-images-dialog";
import { cn } from "@/lib/utils";
import { CheckSquare, XSquare, Trash2 } from "lucide-react";

interface ResultsClientProps {
  images: ImageGridItem[];
  jobId: number;
  speciesList: [string, number][];
  isAdmin?: boolean;
}

const VERIFICATION_STATUSES = [
  { value: "all", label: "Todos" },
  { value: "unverified", label: "Sin verificar" },
  { value: "verified", label: "Verificado" },
  { value: "rejected", label: "Rechazado" },
  { value: "corrected", label: "Corregido" },
];

export function ResultsClient({
  images,
  jobId,
  speciesList,
  isAdmin,
}: ResultsClientProps) {
  const [selectedSpecies, setSelectedSpecies] = useState<string | null>(null);
  const [confidenceRange, setConfidenceRange] = useState<[number, number]>([
    0, 1,
  ]);
  const [verificationFilter, setVerificationFilter] = useState("all");
  const [showEmpty, setShowEmpty] = useState(true);
  const [showStarredOnly, setShowStarredOnly] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const filteredImages = useMemo(() => {
    return images.filter((img) => {
      if (showStarredOnly && !img.starred) return false;

      if (selectedSpecies) {
        const hasSpecies = img.detections.some(
          (d) => d.species === selectedSpecies
        );
        if (!hasSpecies) return false;
      }

      if (img.detections.length > 0) {
        const maxConf = Math.max(
          ...img.detections.map((d) => d.confidence ?? d.detectionConfidence)
        );
        if (maxConf < confidenceRange[0] || maxConf > confidenceRange[1]) {
          return false;
        }
      }

      if (verificationFilter !== "all") {
        if (img.detections.length === 0) return false;
        const hasStatus = img.detections.some(
          (d) => d.verificationStatus === verificationFilter
        );
        if (!hasStatus) return false;
      }

      if (!showEmpty && img.detections.length === 0) {
        return false;
      }

      return true;
    });
  }, [images, selectedSpecies, confidenceRange, verificationFilter, showEmpty, showStarredOnly]);

  const handleToggleSelect = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleSelectAllBlanks = useCallback(() => {
    const blankIds = filteredImages
      .filter(
        (img) =>
          img.status === "processed" &&
          img.detections.length === 0,
      )
      .map((img) => img.id);
    setSelectedIds(new Set(blankIds));
  }, [filteredImages]);

  const handleClearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const handleDeleteComplete = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const clearFilters = () => {
    setSelectedSpecies(null);
    setConfidenceRange([0, 1]);
    setVerificationFilter("all");
    setShowEmpty(true);
    setShowStarredOnly(false);
  };

  const hasActiveFilters =
    selectedSpecies !== null ||
    confidenceRange[0] > 0 ||
    confidenceRange[1] < 1 ||
    verificationFilter !== "all" ||
    !showEmpty ||
    showStarredOnly;

  const blankCount = filteredImages.filter(
    (img) => img.status === "processed" && img.detections.length === 0,
  ).length;

  return (
    <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
      {/* Filter Sidebar */}
      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Filtros</CardTitle>
              {hasActiveFilters && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs h-auto py-1"
                  onClick={clearFilters}
                >
                  Limpiar
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {speciesList.length > 0 && (
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground uppercase tracking-wide">
                  Especie
                </Label>
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {speciesList.map(([species, count]) => (
                    <button
                      key={species}
                      className={cn(
                        "flex items-center justify-between w-full text-left px-2 py-1.5 rounded text-sm hover:bg-accent transition-colors",
                        selectedSpecies === species && "bg-accent font-medium"
                      )}
                      onClick={() =>
                        setSelectedSpecies((prev) =>
                          prev === species ? null : species
                        )
                      }
                    >
                      <span className="truncate">{species}</span>
                      <Badge variant="secondary" className="text-xs ml-2 shrink-0">
                        {count}
                      </Badge>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground uppercase tracking-wide">
                Confianza mínima: {(confidenceRange[0] * 100).toFixed(0)}%
              </Label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={confidenceRange[0]}
                onChange={(e) =>
                  setConfidenceRange([parseFloat(e.target.value), confidenceRange[1]])
                }
                className="w-full accent-primary"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground uppercase tracking-wide">
                Verificación
              </Label>
              <div className="flex flex-wrap gap-1">
                {VERIFICATION_STATUSES.map((s) => (
                  <button
                    key={s.value}
                    className={cn(
                      "px-2 py-1 text-xs rounded-md border transition-colors",
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

            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={showEmpty}
                onChange={(e) => setShowEmpty(e.target.checked)}
                className="accent-primary"
              />
              Mostrar imágenes sin detecciones
            </label>

            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={showStarredOnly}
                onChange={(e) => setShowStarredOnly(e.target.checked)}
                className="accent-primary"
              />
              Solo destacadas
            </label>
          </CardContent>
        </Card>
      </div>

      {/* Image Grid */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">
            Imágenes ({filteredImages.length}
            {filteredImages.length !== images.length &&
              ` de ${images.length}`}
            )
          </h2>
        </div>
        <ImageGrid
          images={filteredImages}
          jobId={jobId}
          selectable={isAdmin}
          selectedIds={selectedIds}
          onToggleSelect={handleToggleSelect}
        />

        {/* Floating selection action bar */}
        {isAdmin && selectedIds.size > 0 && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-background border rounded-lg shadow-lg px-4 py-3 flex items-center gap-3">
            <span className="text-sm font-medium">
              {selectedIds.size} seleccionadas
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={handleClearSelection}
              className="h-8 text-xs"
            >
              <XSquare className="h-3.5 w-3.5 mr-1" />
              Deseleccionar
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setDeleteDialogOpen(true)}
              className="h-8 text-xs"
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" />
              Eliminar de Drive
            </Button>
          </div>
        )}

        {/* Select all blanks bar (shown when no selection and blanks exist) */}
        {isAdmin && selectedIds.size === 0 && blankCount > 0 && (
          <div className="mt-4 flex items-center gap-3 p-3 rounded-lg border bg-muted/50">
            <span className="text-sm text-muted-foreground">
              {blankCount} imágenes vacías en esta vista
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSelectAllBlanks}
              className="h-8 text-xs"
            >
              <CheckSquare className="h-3.5 w-3.5 mr-1" />
              Seleccionar todas las vacías
            </Button>
          </div>
        )}
      </div>

      <BatchDeleteImagesDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        selectedIds={[...selectedIds]}
        selectedCount={selectedIds.size}
        onComplete={handleDeleteComplete}
      />
    </div>
  );
}
