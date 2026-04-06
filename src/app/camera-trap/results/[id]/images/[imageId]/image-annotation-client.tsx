"use client";

import { useRouter } from "next/navigation";
import { BBoxOverlay, type BBoxData } from "@/components/bbox-overlay";
import type { DetectionWithIdentification } from "@/components/annotation-toolbar";
import {
  SpeciesSidebar,
  getVisibleSpecies,
} from "@/components/species-sidebar";
import { useNameDisplay } from "@/lib/species-display";
import { DetectionCardStrip } from "@/components/detection-card-strip";
import { AnnotationHelpPanel } from "@/components/annotation-help-panel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useState, useCallback, useRef, useTransition, useMemo, useOptimistic, useEffect } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { useAnnotationShortcuts } from "@/hooks/use-annotation-shortcuts";
import { useImageZoom } from "@/hooks/use-image-zoom";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  verifyAndAdvance,
  createManualDetection,
  deleteDetection,
  assignSpecies,
  createSpecies,
  toggleConfirmedBlank,
  toggleStarred,
  toggleSetupTag,
  applySetupTagDate,
} from "@/app/camera-trap/actions";
import { Camera } from "lucide-react";
import type { Species } from "@/db/schema";
import type { TaxonomicRank } from "@/lib/types";

interface ImageAnnotationClientProps {
  src: string;
  alt: string;
  boxes: BBoxData[];
  detections: DetectionWithIdentification[];
  speciesList: Species[];
  frequentSpecies: Species[];
  jobId: number;
  imageId: number;
  prevImageId: number | null;
  nextImageId: number | null;
  /**
   * Optional ordered list of image IDs that scopes verify-and-advance to a
   * filtered subset (e.g. when the user is walking a species-filtered grid).
   * When omitted, advance walks the full job. The prev/next button targets
   * are already computed by the parent against this same list, so this prop
   * only needs to flow into the verifyAndAdvance call.
   */
  navigationIds?: number[];
  confirmedBlank: boolean;
  starred: boolean;
  starredBy: string | null;
  setupTag: "deployment" | "retrieval" | null;
  /** When provided, navigation uses these callbacks instead of router.push */
  onNavigate?: (imageId: number) => void;
  onBack?: () => void;
  /** Override the main container height class (default: viewport-based calc) */
  containerClassName?: string;
  /** Called after any data mutation; use to re-fetch data in embedded mode */
  onMutate?: () => void;
}

export function ImageAnnotationClient({
  src,
  alt,
  boxes,
  detections,
  speciesList,
  frequentSpecies,
  jobId,
  imageId,
  prevImageId,
  nextImageId,
  navigationIds,
  confirmedBlank,
  starred,
  starredBy,
  setupTag,
  onNavigate,
  onBack,
  containerClassName,
  onMutate,
}: ImageAnnotationClientProps) {
  const router = useRouter();
  const refresh = useCallback(() => {
    if (onMutate) onMutate();
    else router.refresh();
  }, [onMutate, router]);
  const [selectedBoxId, setSelectedBoxId] = useState<number | null>(null);
  const [bboxesHidden, setBboxesHidden] = useState(false);
  const [deleteDialogDetectionId, setDeleteDialogDetectionId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [, startTransition] = useTransition();
  const isVerifyingRef = useRef(false);
  const [nameDisplay, cycleDisplay] = useNameDisplay();
  const [isConfirmedBlank, setOptimisticBlank] = useOptimistic(confirmedBlank);
  const [isStarred, setOptimisticStarred] = useOptimistic(starred);
  const [currentSetupTag, setOptimisticSetupTag] = useOptimistic(setupTag);
  const [dateSuggestion, setDateSuggestion] = useState<{
    field: "validStart" | "validEnd";
    value: string;
    deploymentId: number;
  } | null>(null);
  const [suggestionDismissed, setSuggestionDismissed] = useState(false);

  // Build species lookup map for display labels
  const speciesMap = useMemo(() => {
    const map = new Map<string, Species>();
    for (const sp of speciesList) {
      map.set(sp.scientificName, sp);
    }
    return map;
  }, [speciesList]);

  // Compute display labels for bbox overlay based on name display mode
  const displayBoxes = useMemo(() => {
    return boxes.map((box) => {
      if (!box.species || box.species === "unknown") return box;
      const sp = speciesMap.get(box.species);
      if (!sp) return box;
      let displayLabel: string;
      switch (nameDisplay) {
        case "common":
          displayLabel = sp.commonName || sp.scientificName;
          break;
        case "spanish":
          displayLabel = sp.spanishName || sp.commonName || sp.scientificName;
          break;
        case "scientific":
          displayLabel = sp.scientificName;
          break;
      }
      return { ...box, displayLabel };
    });
  }, [boxes, speciesMap, nameDisplay]);

  const [addSpeciesOpen, setAddSpeciesOpen] = useState(false);
  const [addSpeciesForm, setAddSpeciesForm] = useState({
    scientificName: "",
    commonName: "",
    spanishName: "",
    taxonomicRank: "species" as TaxonomicRank,
    type: "mammal",
  });
  const [addSpeciesError, setAddSpeciesError] = useState<string | null>(null);

  const isDialogOpen = deleteDialogDetectionId !== null || addSpeciesOpen;
  const { containerRef: zoomContainerRef, wrapperRef: zoomWrapperRef, style: zoomStyle, panHandlers, scale: zoomScale, isPanning, resetZoom } = useImageZoom({ disabled: isDialogOpen });

  const selectedDetection = detections.find((d) => d.id === selectedBoxId) ?? null;

  // Current species for the selected detection (for highlighting in sidebar)
  const currentSpecies = useMemo(() => {
    if (!selectedDetection?.identification) return null;
    return selectedDetection.identification.correctedSpecies || selectedDetection.identification.species;
  }, [selectedDetection]);

  // Auto-focus species search when a detection is selected
  useEffect(() => {
    if (selectedBoxId !== null) {
      searchInputRef.current?.focus();
    } else {
      searchInputRef.current?.blur();
    }
  }, [selectedBoxId]);

  // Visible species list for hotkey assignment
  const visibleSpecies = useMemo(
    () => getVisibleSpecies(speciesList, frequentSpecies, searchQuery),
    [speciesList, frequentSpecies, searchQuery]
  );

  // Detection pending deletion (for dialog)
  const deletingDetection = useMemo(
    () => detections.find((d) => d.id === deleteDialogDetectionId) ?? null,
    [detections, deleteDialogDetectionId]
  );

  // --- Action handlers ---

  const handleQuickVerifyAll = useCallback(() => {
    if (isVerifyingRef.current) return;

    const unverifiedIds = detections
      .filter((d) => d.identification?.verificationStatus === "unverified")
      .map((d) => d.identification!.id);

    if (unverifiedIds.length === 0) return;

    isVerifyingRef.current = true;
    startTransition(async () => {
      try {
        const result = await verifyAndAdvance(
          unverifiedIds,
          jobId,
          imageId,
          navigationIds,
        );
        if (result.success && result.data.nextImageId) {
          if (onNavigate) {
            onNavigate(result.data.nextImageId);
          } else {
            router.push(
              `/camera-trap/results/${jobId}/images/${result.data.nextImageId}`
            );
          }
        } else if (result.success) {
          if (result.data.deploymentCompleted) {
            toast.success("¡Todas las identificaciones revisadas! Instalación marcada como verificada.");
          }
          refresh();
        }
      } finally {
        isVerifyingRef.current = false;
      }
    });
  }, [detections, jobId, imageId, navigationIds, router, onNavigate, refresh]);

  const handleVerifySelected = useCallback(() => {
    if (!selectedDetection?.identification) return;
    if (selectedDetection.identification.verificationStatus !== "unverified") return;
    startTransition(async () => {
      await verifyIdentification(selectedDetection.identification!.id);
      refresh();
    });
  }, [selectedDetection, refresh]);

  const handleRejectSelected = useCallback(() => {
    if (!selectedDetection?.identification) return;
    if (selectedDetection.identification.verificationStatus !== "unverified") return;
    startTransition(async () => {
      await rejectIdentification(selectedDetection.identification!.id);
      refresh();
    });
  }, [selectedDetection, refresh]);

  const handleDrawComplete = useCallback(
    (bbox: { x: number; y: number; width: number; height: number }) => {
      startTransition(async () => {
        const result = await createManualDetection(imageId, bbox);
        if (result.success) {
          setSearchQuery("");
          setSelectedBoxId(result.data.detectionId);
          refresh();
        }
      });
    },
    [imageId, refresh]
  );

  const handleSelectSpecies = useCallback(
    (scientificName: string) => {
      if (!selectedDetection?.identification) return;
      startTransition(async () => {
        const result = await assignSpecies(
          selectedDetection.identification!.id,
          scientificName
        );
        if (result.success) {
          refresh();
        } else {
          console.error("assignSpecies failed:", result.error);
          alert(result.error);
        }
      });
    },
    [selectedDetection, refresh]
  );

  const handleDeleteDetection = useCallback((detectionId: number) => {
    setDeleteDialogDetectionId(detectionId);
  }, []);

  const handleConfirmDelete = useCallback(() => {
    if (!deleteDialogDetectionId) return;
    const idToDelete = deleteDialogDetectionId;
    setDeleteDialogDetectionId(null);
    startTransition(async () => {
      const result = await deleteDetection(idToDelete);
      if (result.success) {
        if (selectedBoxId === idToDelete) {
          setSelectedBoxId(null);
        }
        refresh();
      }
    });
  }, [deleteDialogDetectionId, selectedBoxId, refresh]);

  const handleDeleteSelected = useCallback(() => {
    if (selectedBoxId != null) {
      setDeleteDialogDetectionId(selectedBoxId);
    }
  }, [selectedBoxId]);

  const handleToggleConfirmedBlank = useCallback(() => {
    setOptimisticBlank(!isConfirmedBlank);
    startTransition(async () => {
      await toggleConfirmedBlank(imageId);
      refresh();
    });
  }, [imageId, isConfirmedBlank, refresh]);

  const handleToggleStarred = useCallback(() => {
    setOptimisticStarred(!isStarred);
    startTransition(async () => {
      await toggleStarred(imageId);
      refresh();
    });
  }, [imageId, isStarred, refresh]);

  const handleAddSpecies = useCallback(() => {
    setAddSpeciesForm({
      scientificName: "",
      commonName: "",
      spanishName: "",
      taxonomicRank: "species",
      type: "mammal",
    });
    setAddSpeciesError(null);
    setAddSpeciesOpen(true);
  }, []);

  const handleConfirmAddSpecies = useCallback(() => {
    if (!addSpeciesForm.scientificName || !addSpeciesForm.commonName) return;
    startTransition(async () => {
      const result = await createSpecies({
        scientificName: addSpeciesForm.scientificName,
        commonName: addSpeciesForm.commonName,
        spanishName: addSpeciesForm.spanishName || null,
        taxonomicRank: addSpeciesForm.taxonomicRank,
        type: addSpeciesForm.type,
      });
      if (result.success) {
        setAddSpeciesOpen(false);
        refresh();
      } else {
        setAddSpeciesError(result.error);
      }
    });
  }, [addSpeciesForm, refresh]);

  const handleToggleSetupTag = useCallback(
    (tag: "deployment" | "retrieval") => {
      const newTag = currentSetupTag === tag ? null : tag;
      setOptimisticSetupTag(newTag);
      setSuggestionDismissed(false);
      startTransition(async () => {
        const result = await toggleSetupTag(imageId, tag);
        if (result.success && result.data.suggestion) {
          setDateSuggestion(result.data.suggestion);
        } else {
          setDateSuggestion(null);
        }
        refresh();
      });
    },
    [imageId, currentSetupTag, refresh]
  );

  const handleApplyDate = useCallback(() => {
    if (!dateSuggestion) return;
    startTransition(async () => {
      await applySetupTagDate(
        dateSuggestion.deploymentId,
        dateSuggestion.field,
        dateSuggestion.value
      );
      setDateSuggestion(null);
      refresh();
    });
  }, [dateSuggestion, refresh]);

  // --- Keyboard shortcuts ---

  useAnnotationShortcuts({
    enabled: true,
    onVerify: handleVerifySelected,
    onReject: handleRejectSelected,
    onQuickVerifyAll: handleQuickVerifyAll,
    onDeleteSelected: handleDeleteSelected,
    onToggleConfirmedBlank: handleToggleConfirmedBlank,
    onToggleStarred: handleToggleStarred,
    onToggleSetupDeployment: () => handleToggleSetupTag("deployment"),
    onToggleSetupRetrieval: () => handleToggleSetupTag("retrieval"),
    onToggleBboxes: () => setBboxesHidden((prev) => !prev),
    onResetZoom: resetZoom,
    isDialogOpen,
    onNext: () => {
      if (nextImageId) {
        resetZoom();
        if (onNavigate) {
          onNavigate(nextImageId);
        } else {
          router.push(`/camera-trap/results/${jobId}/images/${nextImageId}`);
        }
      }
    },
    onPrev: () => {
      if (prevImageId) {
        resetZoom();
        if (onNavigate) {
          onNavigate(prevImageId);
        } else {
          router.push(`/camera-trap/results/${jobId}/images/${prevImageId}`);
        }
      }
    },
    onSelectDetection: (index) => {
      if (index < detections.length) {
        setSelectedBoxId(detections[index].id);
      }
    },
    onDeselect: () => {
      setSelectedBoxId(null);
      setSearchQuery("");
    },
    onEscapeBack: () => {
      if (onBack) {
        onBack();
      } else {
        router.push(`/camera-trap/results/${jobId}`, { scroll: false });
      }
    },
    onAssignSpeciesByIndex: (index) => {
      if (index < visibleSpecies.length) {
        handleSelectSpecies(visibleSpecies[index].scientificName);
      }
    },
    detectionCount: detections.length,
    selectedDetectionId: selectedBoxId,
    searchInputRef,
  });

  // --- Deletion dialog info ---
  const deleteDialogSpecies = deletingDetection?.identification
    ? deletingDetection.identification.correctedSpecies || deletingDetection.identification.species
    : null;
  const deleteDialogIndex = deletingDetection
    ? detections.findIndex((d) => d.id === deletingDetection.id) + 1
    : 0;

  return (
    <>
      <div className={`flex gap-4 ${containerClassName ?? "h-[calc(100vh-10rem)]"}`}>
        {/* Left sidebar — Species list */}
        <aside className="w-56 shrink-0 flex flex-col min-w-0 overflow-hidden border rounded-lg bg-background">
          <SpeciesSidebar
            speciesList={speciesList}
            frequentSpecies={frequentSpecies}
            selectedDetectionId={selectedBoxId}
            currentSpecies={currentSpecies}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            onSelectSpecies={handleSelectSpecies}
            onAddSpecies={handleAddSpecies}
            searchInputRef={searchInputRef}
            nameDisplay={nameDisplay}
            onCycleDisplay={cycleDisplay}
          />
        </aside>

        {/* Main content */}
        <div className="flex-1 flex flex-col min-w-0 gap-2">
          {/* Detection cards strip */}
          <DetectionCardStrip
            detections={detections}
            selectedDetectionId={selectedBoxId}
            onSelectDetection={(id) =>
              setSelectedBoxId((prev) => (prev === id ? null : id))
            }
            onDeleteDetection={handleDeleteDetection}
            confirmedBlank={isConfirmedBlank}
            onToggleConfirmedBlank={handleToggleConfirmedBlank}
            nameDisplay={nameDisplay}
            speciesList={speciesList}
          />

          {/* Setup tag buttons */}
          <div className="flex items-center gap-2">
            <Button
              variant={currentSetupTag === "deployment" ? "default" : "outline"}
              size="sm"
              className={`h-7 text-xs gap-1.5 ${currentSetupTag === "deployment" ? "bg-blue-600 hover:bg-blue-700 text-white" : ""}`}
              onClick={() => handleToggleSetupTag("deployment")}
              title="Marcar como instalación (i)"
            >
              <Camera className="size-3.5" />
              Instalación
            </Button>
            <Button
              variant={currentSetupTag === "retrieval" ? "default" : "outline"}
              size="sm"
              className={`h-7 text-xs gap-1.5 ${currentSetupTag === "retrieval" ? "bg-orange-600 hover:bg-orange-700 text-white" : ""}`}
              onClick={() => handleToggleSetupTag("retrieval")}
              title="Marcar como recogida (t)"
            >
              <Camera className="size-3.5" />
              Recogida
            </Button>
          </div>

          {/* Date suggestion banner */}
          {dateSuggestion && !suggestionDismissed && (
            <div className="flex items-center gap-3 px-3 py-2 rounded-md border bg-blue-50 border-blue-200 text-sm">
              <div className="flex-1">
                <span className="text-blue-800">
                  Timestamp: {dateSuggestion.value.replace("T", " ")}
                  {" — "}
                  ¿Usar como{" "}
                  {dateSuggestion.field === "validStart"
                    ? "fecha de inicio válida"
                    : "fecha de fin válida"}
                  ?
                </span>
              </div>
              <Button
                variant="default"
                size="sm"
                className="h-7 text-xs bg-blue-600 hover:bg-blue-700"
                onClick={handleApplyDate}
              >
                Aplicar
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setSuggestionDismissed(true)}
              >
                Cerrar
              </Button>
            </div>
          )}

          {/* Image with bbox overlay */}
          <div
            ref={zoomContainerRef}
            className={`flex-1 min-h-0 rounded-lg overflow-hidden border bg-black flex items-center justify-center relative ${isPanning ? "cursor-grab" : ""}`}
          >
            <div ref={zoomWrapperRef} className="max-h-full" style={zoomStyle} {...panHandlers}>
              <BBoxOverlay
                src={src}
                alt={alt}
                boxes={bboxesHidden ? [] : displayBoxes}
                selectedBoxId={selectedBoxId}
                onBoxClick={(box) =>
                  setSelectedBoxId((prev) => (prev === box.id ? null : box.id))
                }
                editable={!isPanning}
                onDrawComplete={handleDrawComplete}
              />
            </div>
            {zoomScale > 1 && (
              <span className="absolute top-2 right-2 px-1.5 py-0.5 text-xs font-mono bg-black/60 text-white rounded">
                {zoomScale.toFixed(1)}x
              </span>
            )}
          </div>

          {/* Help panel + star + back link */}
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <AnnotationHelpPanel />
            </div>
            <Button
              variant={isStarred ? "default" : "outline"}
              size="sm"
              className={`shrink-0 gap-1.5 ${isStarred ? "bg-amber-500 hover:bg-amber-600 text-white" : ""}`}
              onClick={handleToggleStarred}
              title={isStarred && starredBy ? `Destacada por ${starredBy}` : "Destacar imagen (s)"}
            >
              <svg
                className="size-4"
                fill={isStarred ? "currentColor" : "none"}
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z" />
              </svg>
              {isStarred ? "Destacada" : "Destacar"}
            </Button>
            {onBack ? (
              <Button variant="outline" size="sm" className="shrink-0" onClick={onBack}>
                Volver a Cuadrícula
              </Button>
            ) : (
              <Button asChild variant="outline" size="sm" className="shrink-0">
                <Link href={`/camera-trap/results/${jobId}`} scroll={false}>
                  Volver a Cuadrícula
                </Link>
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <Dialog
        open={deleteDialogDetectionId !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteDialogDetectionId(null);
        }}
      >
        <DialogContent onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === "Delete" || e.key === "Backspace" || e.key === "d") {
            e.preventDefault();
            handleConfirmDelete();
          }
        }}>
          <DialogHeader>
            <DialogTitle>Eliminar detección #{deleteDialogIndex}</DialogTitle>
            <DialogDescription>
              {deleteDialogSpecies && deleteDialogSpecies !== "unknown"
                ? `Esta detección está identificada como "${deleteDialogSpecies}". `
                : ""}
              Esta acción no se puede deshacer. La detección y su identificación serán eliminadas permanentemente.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogDetectionId(null)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmDelete}
            >
              Eliminar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add species dialog */}
      <Dialog
        open={addSpeciesOpen}
        onOpenChange={(open) => {
          if (!open) setAddSpeciesOpen(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Agregar Especie</DialogTitle>
            <DialogDescription>
              Agregar una nueva especie al catálogo.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="add-scientificName">Nombre científico *</Label>
              <Input
                id="add-scientificName"
                value={addSpeciesForm.scientificName}
                onChange={(e) =>
                  setAddSpeciesForm((f) => ({ ...f, scientificName: e.target.value }))
                }
                placeholder="Ej: Cuniculus paca"
              />
            </div>
            <div>
              <Label htmlFor="add-commonName">Nombre común (inglés) *</Label>
              <Input
                id="add-commonName"
                value={addSpeciesForm.commonName}
                onChange={(e) =>
                  setAddSpeciesForm((f) => ({ ...f, commonName: e.target.value }))
                }
                placeholder="Ej: Lowland paca"
              />
            </div>
            <div>
              <Label htmlFor="add-spanishName">Nombre común (español)</Label>
              <Input
                id="add-spanishName"
                value={addSpeciesForm.spanishName}
                onChange={(e) =>
                  setAddSpeciesForm((f) => ({ ...f, spanishName: e.target.value }))
                }
                placeholder="Ej: Guanta"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Rango taxonómico</Label>
                <Select
                  value={addSpeciesForm.taxonomicRank}
                  onValueChange={(v) =>
                    setAddSpeciesForm((f) => ({ ...f, taxonomicRank: v as TaxonomicRank }))
                  }
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="species">Especie</SelectItem>
                    <SelectItem value="genus">Género</SelectItem>
                    <SelectItem value="family">Familia</SelectItem>
                    <SelectItem value="order">Orden</SelectItem>
                    <SelectItem value="class">Clase</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Tipo</Label>
                <Select
                  value={addSpeciesForm.type}
                  onValueChange={(v) =>
                    setAddSpeciesForm((f) => ({ ...f, type: v }))
                  }
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mammal">Mamífero</SelectItem>
                    <SelectItem value="bird">Ave</SelectItem>
                    <SelectItem value="reptile">Reptil</SelectItem>
                    <SelectItem value="amphibian">Anfibio</SelectItem>
                    <SelectItem value="insect">Insecto</SelectItem>
                    <SelectItem value="system">Sistema</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {addSpeciesError && (
              <p className="text-sm text-destructive">{addSpeciesError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddSpeciesOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={handleConfirmAddSpecies}
              disabled={!addSpeciesForm.scientificName || !addSpeciesForm.commonName}
            >
              Agregar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
