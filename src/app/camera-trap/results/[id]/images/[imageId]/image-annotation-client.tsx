"use client";

import { useRouter } from "next/navigation";
import { BBoxOverlay, type BBoxData } from "@/components/bbox-overlay";
import type { DetectionWithIdentification } from "@/components/annotation-toolbar";
import { SpeciesSidebar, getVisibleSpecies } from "@/components/species-sidebar";
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
import { useState, useCallback, useRef, useTransition, useMemo } from "react";
import Link from "next/link";
import { useAnnotationShortcuts } from "@/hooks/use-annotation-shortcuts";
import {
  verifyIdentification,
  rejectIdentification,
  verifyAndAdvance,
  createManualDetection,
  deleteDetection,
  assignSpecies,
} from "@/app/camera-trap/actions";
import type { Species } from "@/db/schema";

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
}: ImageAnnotationClientProps) {
  const router = useRouter();
  const [selectedBoxId, setSelectedBoxId] = useState<number | null>(null);
  const [deleteDialogDetectionId, setDeleteDialogDetectionId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [, startTransition] = useTransition();
  const isVerifyingRef = useRef(false);

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

  // --- Keyboard shortcuts ---

  useAnnotationShortcuts({
    enabled: true,
    onVerify: handleVerifySelected,
    onReject: handleRejectSelected,
    onQuickVerifyAll: handleQuickVerifyAll,
    onDeleteSelected: handleDeleteSelected,
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
            searchInputRef={searchInputRef}
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
          />

          {/* Image with bbox overlay */}
          <div className="flex-1 min-h-0 rounded-lg overflow-hidden border bg-muted">
            <BBoxOverlay
              src={src}
              alt={alt}
              boxes={boxes}
              selectedBoxId={selectedBoxId}
              onBoxClick={(box) =>
                setSelectedBoxId((prev) => (prev === box.id ? null : box.id))
              }
              editable
              onDrawComplete={handleDrawComplete}
            />
          </div>

          {/* Help panel + back link */}
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <AnnotationHelpPanel />
            </div>
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
        <DialogContent>
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
    </>
  );
}
