"use client";

import { useRouter } from "next/navigation";
import { BBoxOverlay, type BBoxData } from "@/components/bbox-overlay";
import type { DetectionWithIdentification } from "@/components/annotation-toolbar";
import {
  SpeciesSidebar,
  getVisibleSpecies,
  getStoredDisplay,
  DISPLAY_KEY,
  type NameDisplay,
} from "@/components/species-sidebar";
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
import { useState, useCallback, useRef, useTransition, useMemo, useOptimistic } from "react";
import Link from "next/link";
import { useAnnotationShortcuts } from "@/hooks/use-annotation-shortcuts";
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
} from "@/app/camera-trap/actions";
import type { Species } from "@/db/schema";
import type { TaxonomicRank } from "@/lib/types";

interface ImageAnnotationClientProps {
  src: string;
  alt: string;
  boxes: BBoxData[];
  detections: DetectionWithIdentification[];
  speciesList: Species[];
  recentSpecies: Species[];
  jobId: number;
  imageId: number;
  prevImageId: number | null;
  nextImageId: number | null;
  confirmedBlank: boolean;
  starred: boolean;
  starredBy: string | null;
}

export function ImageAnnotationClient({
  src,
  alt,
  boxes,
  detections,
  speciesList,
  recentSpecies,
  jobId,
  imageId,
  prevImageId,
  nextImageId,
  confirmedBlank,
  starred,
  starredBy,
}: ImageAnnotationClientProps) {
  const router = useRouter();
  const [selectedBoxId, setSelectedBoxId] = useState<number | null>(null);
  const [deleteDialogDetectionId, setDeleteDialogDetectionId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [, startTransition] = useTransition();
  const isVerifyingRef = useRef(false);
  const [nameDisplay, setNameDisplay] = useState<NameDisplay>(getStoredDisplay);
  const [isConfirmedBlank, setOptimisticBlank] = useOptimistic(confirmedBlank);
  const [isStarred, setOptimisticStarred] = useOptimistic(starred);

  const cycleDisplay = useCallback(() => {
    setNameDisplay((prev) => {
      const cycle: NameDisplay[] = ["common", "spanish", "scientific"];
      const idx = cycle.indexOf(prev);
      const next = cycle[(idx + 1) % cycle.length];
      localStorage.setItem(DISPLAY_KEY, next);
      return next;
    });
  }, []);

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

  const selectedDetection = detections.find((d) => d.id === selectedBoxId) ?? null;

  // Current species for the selected detection (for highlighting in sidebar)
  const currentSpecies = useMemo(() => {
    if (!selectedDetection?.identification) return null;
    return selectedDetection.identification.correctedSpecies || selectedDetection.identification.species;
  }, [selectedDetection]);

  // Visible species list for hotkey assignment
  const visibleSpecies = useMemo(
    () => getVisibleSpecies(speciesList, recentSpecies, searchQuery),
    [speciesList, recentSpecies, searchQuery]
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
        const result = await verifyAndAdvance(unverifiedIds, jobId, imageId);
        if (result.success && result.data.nextImageId) {
          router.push(
            `/camera-trap/results/${jobId}/images/${result.data.nextImageId}`
          );
        } else if (result.success) {
          router.refresh();
        }
      } finally {
        isVerifyingRef.current = false;
      }
    });
  }, [detections, jobId, imageId, router]);

  const handleVerifySelected = useCallback(() => {
    if (!selectedDetection?.identification) return;
    if (selectedDetection.identification.verificationStatus !== "unverified") return;
    startTransition(async () => {
      await verifyIdentification(selectedDetection.identification!.id);
      router.refresh();
    });
  }, [selectedDetection, router]);

  const handleRejectSelected = useCallback(() => {
    if (!selectedDetection?.identification) return;
    if (selectedDetection.identification.verificationStatus !== "unverified") return;
    startTransition(async () => {
      await rejectIdentification(selectedDetection.identification!.id);
      router.refresh();
    });
  }, [selectedDetection, router]);

  const handleDrawComplete = useCallback(
    (bbox: { x: number; y: number; width: number; height: number }) => {
      startTransition(async () => {
        const result = await createManualDetection(imageId, bbox);
        if (result.success) {
          setSelectedBoxId(result.data.detectionId);
          router.refresh();
        }
      });
    },
    [imageId, router]
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
          router.refresh();
        }
      });
    },
    [selectedDetection, router]
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
        router.refresh();
      }
    });
  }, [deleteDialogDetectionId, selectedBoxId, router]);

  const handleDeleteSelected = useCallback(() => {
    if (selectedBoxId != null) {
      setDeleteDialogDetectionId(selectedBoxId);
    }
  }, [selectedBoxId]);

  const handleToggleConfirmedBlank = useCallback(() => {
    setOptimisticBlank(!isConfirmedBlank);
    startTransition(async () => {
      await toggleConfirmedBlank(imageId);
      router.refresh();
    });
  }, [imageId, isConfirmedBlank, router]);

  const handleToggleStarred = useCallback(() => {
    setOptimisticStarred(!isStarred);
    startTransition(async () => {
      await toggleStarred(imageId);
      router.refresh();
    });
  }, [imageId, isStarred, router]);

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
        router.refresh();
      } else {
        setAddSpeciesError(result.error);
      }
    });
  }, [addSpeciesForm, router]);

  // --- Keyboard shortcuts ---

  useAnnotationShortcuts({
    enabled: true,
    onVerify: handleVerifySelected,
    onReject: handleRejectSelected,
    onQuickVerifyAll: handleQuickVerifyAll,
    onDeleteSelected: handleDeleteSelected,
    onToggleConfirmedBlank: handleToggleConfirmedBlank,
    onToggleStarred: handleToggleStarred,
    isDialogOpen: deleteDialogDetectionId !== null || addSpeciesOpen,
    onNext: () => {
      if (nextImageId) {
        router.push(`/camera-trap/results/${jobId}/images/${nextImageId}`);
      }
    },
    onPrev: () => {
      if (prevImageId) {
        router.push(`/camera-trap/results/${jobId}/images/${prevImageId}`);
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
      <div className="flex gap-4 h-[calc(100vh-10rem)]">
        {/* Left sidebar — Species list */}
        <aside className="w-56 shrink-0 flex flex-col min-w-0 overflow-hidden border rounded-lg bg-background">
          <SpeciesSidebar
            speciesList={speciesList}
            recentSpecies={recentSpecies}
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

          {/* Image with bbox overlay */}
          <div className="flex-1 min-h-0 rounded-lg overflow-hidden border bg-black flex items-center">
            <BBoxOverlay
              src={src}
              alt={alt}
              boxes={displayBoxes}
              selectedBoxId={selectedBoxId}
              onBoxClick={(box) =>
                setSelectedBoxId((prev) => (prev === box.id ? null : box.id))
              }
              editable
              onDrawComplete={handleDrawComplete}
            />
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
            <Button asChild variant="outline" size="sm" className="shrink-0">
              <Link href={`/camera-trap/results/${jobId}`}>
                Volver a Cuadrícula
              </Link>
            </Button>
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
