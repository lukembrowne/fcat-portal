"use client";

import { useRouter } from "next/navigation";
import { BBoxOverlay, type BBoxData } from "@/components/bbox-overlay";
import type { DetectionWithIdentification } from "@/components/annotation-toolbar";
import { AnnotationPickerPopover } from "@/components/annotation-picker-popover";
import { AnnotationToolsSidebar } from "@/components/annotation-tools-sidebar";
import { Popover, PopoverAnchor } from "@/components/ui/popover";
import { useAnnotationPicker } from "@/hooks/use-annotation-picker";
import { useNameDisplay } from "@/lib/species-display";
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
import { toast } from "sonner";
import { useAnnotationShortcuts } from "@/hooks/use-annotation-shortcuts";
import { useImageZoom } from "@/hooks/use-image-zoom";
import { preloadImage } from "@/lib/annotation-prefetch";
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
import { Loader2 } from "lucide-react";
import type { Species } from "@/db/schema";
import type { TaxonomicRank } from "@/lib/types";

interface ImageAnnotationClientProps {
  src: string;
  alt: string;
  boxes: BBoxData[];
  detections: DetectionWithIdentification[];
  speciesList: Species[];
  /**
   * 10 species mapped to hotkey slots 1-9 and 0. Computed project-wide
   * once per page load (see `getFrequentSpecies(null, 10)`); stays stable
   * for the whole session so muscle memory survives between images.
   */
  hotkeySlots: Species[];
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
  /** When false, all mutation UI (verify, assign, draw, delete, tags) is hidden.
   *  Defaults to true for backwards compatibility with embedded mode. */
  canEdit?: boolean;
  /** Override the main container height class (default: viewport-based calc) */
  containerClassName?: string;
  /** Called after any data mutation; use to re-fetch data in embedded mode */
  onMutate?: () => void;
  /**
   * When true, render a translucent loading spinner over the image area
   * only (sidebar, detection cards, and toolbar stay visible). Used by
   * the embedded overlay while it fetches the next image's payload on a
   * prefetch cache miss, so the user gets feedback without a full
   * white-screen flash.
   */
  loadingOverlay?: boolean;
}

export function ImageAnnotationClient({
  src,
  alt,
  boxes,
  detections,
  speciesList,
  hotkeySlots,
  jobId,
  imageId,
  prevImageId,
  nextImageId,
  navigationIds,
  confirmedBlank,
  starred,
  starredBy,
  setupTag,
  canEdit = true,
  onNavigate,
  onBack,
  containerClassName,
  onMutate,
  loadingOverlay = false,
}: ImageAnnotationClientProps) {
  const router = useRouter();
  const refresh = useCallback(() => {
    if (onMutate) onMutate();
    else router.refresh();
  }, [onMutate, router]);
  const [selectedBoxId, setSelectedBoxId] = useState<number | null>(null);
  const [bboxesHidden, setBboxesHidden] = useState(false);
  const [deleteDialogDetectionId, setDeleteDialogDetectionId] = useState<number | null>(null);
  // Pixel dimensions of the currently rendered image, reported by BBoxOverlay.
  // Used to absolutely position the popover anchor against the bbox's
  // normalized coordinates.
  const [imgSize, setImgSize] = useState({ width: 0, height: 0 });
  const popoverSearchInputRef = useRef<HTMLInputElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
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
  const { containerRef: zoomContainerRef, wrapperRef: zoomWrapperRef, style: zoomStyle, panHandlers, scale: zoomScale, isPanning, isZooming, resetZoom } = useImageZoom({ disabled: isDialogOpen });

  const picker = useAnnotationPicker({
    selectedBoxId,
    detections,
    isPanning,
    isZooming,
    bboxesHidden,
    isDialogOpen,
  });
  const { selectedDetection } = picker;

  // 1-based index of the selected detection, used in the popover header.
  const selectedDetectionNumber = useMemo(() => {
    if (selectedBoxId == null) return 0;
    const idx = detections.findIndex((d) => d.id === selectedBoxId);
    return idx < 0 ? 0 : idx + 1;
  }, [detections, selectedBoxId]);

  // Standalone-page prefetch: when this component is rendered as the
  // top-level annotation page (no `onNavigate` callback), warm the next /
  // previous image's RSC payload and full image bytes so arrow-key
  // navigation feels closer to instant. The overlay-mode parent
  // (`DeploymentGalleryClient`) handles its own richer prefetching, so we
  // skip this effect when `onNavigate` is provided.
  useEffect(() => {
    if (onNavigate) return;
    const handles: { cancel(): void }[] = [];
    if (nextImageId) {
      router.prefetch(`/camera-trap/results/${jobId}/images/${nextImageId}`);
      handles.push(preloadImage(`/api/ct-images/${nextImageId}?size=full`));
    }
    if (prevImageId) {
      router.prefetch(`/camera-trap/results/${jobId}/images/${prevImageId}`);
      handles.push(preloadImage(`/api/ct-images/${prevImageId}?size=full`));
    }
    return () => {
      for (const h of handles) h.cancel();
    };
  }, [router, onNavigate, jobId, nextImageId, prevImageId]);

  // Stable hotkey slots — memoized so the shortcut hook's useEffect doesn't
  // re-register on every parent re-render (server returns a fresh array
  // identity each render; only changes on page navigation).
  const stableHotkeySlots = useMemo(() => hotkeySlots, [hotkeySlots]);

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

  const handleDrawComplete = useCallback(
    (bbox: { x: number; y: number; width: number; height: number }) => {
      startTransition(async () => {
        const result = await createManualDetection(imageId, bbox);
        if (result.success) {
          setSelectedBoxId(result.data.detectionId);
          refresh();
        }
      });
    },
    [imageId, refresh]
  );

  const handleSelectSpecies = useCallback(
    (scientificName: string) => {
      if (!selectedDetection) return;
      startTransition(async () => {
        const result = await assignSpecies(
          selectedDetection.id,
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
      const result = await toggleConfirmedBlank(imageId);
      if (!result.success) {
        toast.error(result.error);
      }
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
    onQuickVerifyAll: canEdit ? handleQuickVerifyAll : undefined,
    onDeleteSelected: canEdit ? handleDeleteSelected : undefined,
    onToggleConfirmedBlank: canEdit ? handleToggleConfirmedBlank : undefined,
    onToggleStarred: canEdit ? handleToggleStarred : undefined,
    onToggleSetupDeployment: canEdit ? () => handleToggleSetupTag("deployment") : undefined,
    onToggleSetupRetrieval: canEdit ? () => handleToggleSetupTag("retrieval") : undefined,
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
    },
    onEscapeBack: () => {
      if (onBack) {
        onBack();
      } else {
        router.push(`/camera-trap/results/${jobId}`, { scroll: false });
      }
    },
    onAssignSpeciesByIndex: canEdit ? (index) => {
      if (index < stableHotkeySlots.length) {
        handleSelectSpecies(stableHotkeySlots[index].scientificName);
      }
    } : undefined,
    detectionCount: detections.length,
    selectedDetectionId: selectedBoxId,
    searchInputRef: popoverSearchInputRef,
  });

  // --- Deletion dialog info ---
  const deleteDialogSpecies = deletingDetection?.identification
    ? deletingDetection.identification.correctedSpecies || deletingDetection.identification.species
    : null;
  const deleteDialogIndex = deletingDetection
    ? detections.findIndex((d) => d.id === deletingDetection.id) + 1
    : 0;

  const selectedBox = selectedBoxId != null
    ? displayBoxes.find((b) => b.id === selectedBoxId) ?? null
    : null;

  return (
    <Popover
      open={picker.open}
      onOpenChange={(next) => {
        // Esc and outside-clicks land here — deselect the bbox so the
        // picker.open gate flips closed on its own.
        if (!next) {
          setSelectedBoxId(null);
        }
      }}
    >
      <div className={`flex gap-4 ${containerClassName ?? "h-[calc(100vh-10rem)]"}`}>
        {/* Left sidebar — annotation tools */}
        <aside className="w-56 shrink-0 flex flex-col min-w-0 overflow-hidden border rounded-lg bg-background">
          <AnnotationToolsSidebar
            detections={detections}
            selectedDetectionId={selectedBoxId}
            onSelectDetection={(id) =>
              setSelectedBoxId((prev) => (prev === id ? null : id))
            }
            onDeleteDetection={canEdit ? handleDeleteDetection : undefined}
            confirmedBlank={isConfirmedBlank}
            onToggleConfirmedBlank={canEdit ? handleToggleConfirmedBlank : undefined}
            speciesList={speciesList}
            nameDisplay={nameDisplay}
            onCycleDisplay={cycleDisplay}
            canEdit={canEdit}
            setupTag={currentSetupTag}
            onToggleSetupDeployment={canEdit ? () => handleToggleSetupTag("deployment") : undefined}
            onToggleSetupRetrieval={canEdit ? () => handleToggleSetupTag("retrieval") : undefined}
            isStarred={isStarred}
            starredBy={starredBy}
            onToggleStarred={canEdit ? handleToggleStarred : undefined}
            dateSuggestion={
              dateSuggestion && !suggestionDismissed
                ? { field: dateSuggestion.field, value: dateSuggestion.value }
                : null
            }
            onApplyDateSuggestion={canEdit ? handleApplyDate : undefined}
            onDismissDateSuggestion={() => setSuggestionDismissed(true)}
            jobId={jobId}
            onBack={onBack}
          />
        </aside>

        {/* Main content */}
        <div className="flex-1 flex flex-col min-w-0 gap-2">
          {/* Image with bbox overlay */}
          <div
            ref={zoomContainerRef}
            className={`flex-1 min-h-0 rounded-lg overflow-hidden border bg-black flex items-center justify-center relative ${isPanning ? "cursor-grab" : ""}`}
          >
            <div
              ref={zoomWrapperRef}
              className="max-h-full relative inline-block"
              style={zoomStyle}
              {...panHandlers}
            >
              <BBoxOverlay
                src={src}
                alt={alt}
                boxes={bboxesHidden || isConfirmedBlank ? [] : displayBoxes}
                selectedBoxId={selectedBoxId}
                onBoxClick={(box) =>
                  setSelectedBoxId((prev) => (prev === box.id ? null : box.id))
                }
                editable={!isPanning && canEdit}
                onDrawComplete={canEdit ? handleDrawComplete : undefined}
                onResize={setImgSize}
              />
              {/* Invisible anchor sized/positioned to the selected bbox.
                  Radix attaches the popover to this element; sideOffset>0
                  guarantees the popover never overlaps the bbox itself. */}
              {selectedBox && imgSize.width > 0 && (
                <PopoverAnchor asChild>
                  <div
                    ref={anchorRef}
                    className="absolute pointer-events-none"
                    style={{
                      left: selectedBox.x * imgSize.width,
                      top: selectedBox.y * imgSize.height,
                      width: selectedBox.width * imgSize.width,
                      height: selectedBox.height * imgSize.height,
                    }}
                  />
                </PopoverAnchor>
              )}
            </div>
            {zoomScale > 1 && (
              <span className="absolute top-2 right-2 px-1.5 py-0.5 text-xs font-mono bg-black/60 text-white rounded">
                {zoomScale.toFixed(1)}x
              </span>
            )}
            {loadingOverlay && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40 pointer-events-none">
                <div className="rounded-full bg-black/70 p-3">
                  <Loader2 className="h-6 w-6 animate-spin text-white" />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Contextual picker anchored to the selected bbox. Rendered inside
          the Popover root so PopoverAnchor in the zoom wrapper governs
          its position. */}
      <AnnotationPickerPopover
        open={picker.open}
        selectedDetection={picker.selectedDetection}
        detectionNumber={selectedDetectionNumber}
        currentSpecies={picker.currentSpecies}
        hotkeySlots={stableHotkeySlots}
        speciesList={speciesList}
        nameDisplay={nameDisplay}
        canEdit={canEdit}
        containerRef={zoomContainerRef}
        searchInputRef={popoverSearchInputRef}
        onAssignSpecies={handleSelectSpecies}
        onAssignSpeciesByIndex={(index) => {
          if (canEdit && index < stableHotkeySlots.length) {
            handleSelectSpecies(stableHotkeySlots[index].scientificName);
          }
        }}
        onAddSpecies={canEdit ? handleAddSpecies : undefined}
        onDelete={handleDeleteSelected}
      />

      {/* Delete confirmation dialog — editors only */}
      {canEdit && <Dialog
        open={deleteDialogDetectionId !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteDialogDetectionId(null);
        }}
      >
        <DialogContent
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            deleteButtonRef.current?.focus();
          }}
          onKeyDown={(e: React.KeyboardEvent) => {
            // Note: Backspace is intentionally NOT handled here — it opens the
            // dialog via the window-level shortcut, and if it also auto-confirmed
            // here the detection would be deleted in a single keypress with no
            // real confirmation step. Require explicit Enter/click to confirm.
            if (
              e.key === "Delete" ||
              e.key === "d" ||
              e.key === "Enter"
            ) {
              e.preventDefault();
              handleConfirmDelete();
            }
          }}
        >
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
              ref={deleteButtonRef}
              variant="destructive"
              onClick={handleConfirmDelete}
            >
              Eliminar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>}

      {/* Add species dialog — editors only */}
      {canEdit && <Dialog
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
      </Dialog>}
    </Popover>
  );
}
