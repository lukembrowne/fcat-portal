"use client";

import { useState, useMemo, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ImageGrid, type ImageGridItem } from "@/components/image-grid";
import { BulkDeleteBlanksDialog } from "./bulk-delete-blanks-dialog";
import { cn } from "@/lib/utils";
import { Trash2 } from "lucide-react";

const COLUMN_OPTIONS = [2, 3, 4, 6] as const;

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
  const [confidenceRange, setConfidenceRange] = useState<[number, number]>([
    0, 1,
  ]);
  const [verificationFilter, setVerificationFilter] = useState("all");
  const [showEmpty, setShowEmpty] = useState(true);
  const [showStarredOnly, setShowStarredOnly] = useState(false);
  const [showBlanksOnly, setShowBlanksOnly] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

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
  }, [images, selectedSpecies, confidenceRange, verificationFilter, showEmpty, showStarredOnly, showBlanksOnly]);

  const clearFilters = () => {
    setSelectedSpecies(null);
    setConfidenceRange([0, 1]);
    setVerificationFilter("all");
    setShowEmpty(true);
    setShowStarredOnly(false);
    setShowBlanksOnly(false);
  };

  const hasActiveFilters =
    selectedSpecies !== null ||
    confidenceRange[0] > 0 ||
    confidenceRange[1] < 1 ||
    verificationFilter !== "all" ||
    !showEmpty ||
    showStarredOnly ||
    showBlanksOnly;

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

            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={showBlanksOnly}
                onChange={(e) => setShowBlanksOnly(e.target.checked)}
                className="accent-primary"
              />
              Solo vacías
            </label>

            {isAdmin && (
              <>
                <div className="border-t pt-3 mt-1">
                  <Label className="text-xs text-muted-foreground uppercase tracking-wide">
                    Herramientas
                  </Label>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full mt-2 text-xs text-destructive border-destructive/30 hover:bg-destructive/10"
                    onClick={() => {
                      setBulkDeleteOpen(true);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                    Eliminar vacías
                  </Button>
                </div>
              </>
            )}
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
        <ImageGrid
          images={filteredImages}
          jobId={jobId}
          columns={gridColumns}
        />
      </div>

      {isAdmin && bulkDeleteOpen && (
        <BulkDeleteBlanksDialog
          onClose={() => setBulkDeleteOpen(false)}
          jobId={jobId}
        />
      )}
    </div>
  );
}
