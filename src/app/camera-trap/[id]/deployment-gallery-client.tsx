"use client";

import { useState, useTransition, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, ArrowLeft } from "lucide-react";
import { ResultsClient, type ResultsSpeciesEntry } from "../results/[id]/results-client";
import { ImageAnnotationClient } from "../results/[id]/images/[imageId]/image-annotation-client";
import { getImageAnnotationData } from "../actions";
import type { ImageGridItem } from "@/components/image-grid";

type AnnotationData = NonNullable<Awaited<ReturnType<typeof getImageAnnotationData>>>;

interface DeploymentGalleryClientProps {
  images: ImageGridItem[];
  jobId: number;
  speciesList: ResultsSpeciesEntry[];
  deploymentName: string;
}

export function DeploymentGalleryClient({
  images,
  jobId,
  speciesList,
  deploymentName,
}: DeploymentGalleryClientProps) {
  const router = useRouter();
  const [annotationData, setAnnotationData] = useState<AnnotationData | null>(null);
  const [loading, startLoading] = useTransition();

  // Live ordered list of currently filtered image IDs (updated by ResultsClient
  // whenever the user changes a filter). When the annotation overlay opens we
  // snapshot this list into `navigationIds` and use the snapshot for the
  // duration of the overlay session — so verifying images doesn't yank them
  // out from under the user.
  const filteredIdsRef = useRef<number[]>(images.map((img) => img.id));
  const [navigationIds, setNavigationIds] = useState<number[] | null>(null);

  const handleFilteredIdsChange = useCallback((ids: number[]) => {
    filteredIdsRef.current = ids;
  }, []);

  // Lock body scroll when annotation overlay is open
  useEffect(() => {
    if (annotationData) {
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = ""; };
    }
  }, [annotationData]);

  const loadImage = useCallback(
    (imageId: number) => {
      // Snapshot the current filtered list so navigation stays scoped to what
      // the user was looking at when they clicked. Empty list (no filters / no
      // images yet) → fall back to full-job navigation by passing undefined.
      const snapshot =
        filteredIdsRef.current.length > 0 ? [...filteredIdsRef.current] : null;
      setNavigationIds(snapshot);
      startLoading(async () => {
        const data = await getImageAnnotationData(
          imageId,
          jobId,
          snapshot ?? undefined,
        );
        if (data) {
          setAnnotationData(data);
        }
      });
    },
    [jobId]
  );

  const handleBack = useCallback(() => {
    setAnnotationData(null);
    setNavigationIds(null);
    router.refresh();
  }, [router]);

  // Re-fetch annotation data after a mutation (species assign, verify, delete, etc.)
  // Uses direct async call instead of startLoading to avoid showing the loading spinner.
  // Reuses the frozen navigationIds snapshot so prev/next/total stay stable.
  const handleMutate = useCallback(async () => {
    if (!annotationData) return;
    const data = await getImageAnnotationData(
      annotationData.image.id,
      jobId,
      navigationIds ?? undefined,
    );
    if (data) {
      setAnnotationData(data);
    }
  }, [annotationData, jobId, navigationIds]);

  // Full-viewport annotation overlay
  if (annotationData) {
    const { image } = annotationData;
    return (
      <div className="fixed inset-0 z-50 bg-background flex flex-col">
        {/* Compact top bar */}
        <div className="flex items-center justify-between px-4 py-2 border-b shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Button variant="ghost" size="sm" onClick={handleBack} className="shrink-0 gap-1.5">
              <ArrowLeft className="h-4 w-4" />
              <span className="hidden sm:inline">{deploymentName}</span>
            </Button>
            <span className="text-muted-foreground hidden sm:inline">/</span>
            <span className="font-medium text-sm truncate">{image.filename}</span>
            {annotationData.timestamp && (
              <span className="text-xs text-muted-foreground hidden md:inline">
                {annotationData.timestamp}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* Verification progress */}
            {annotationData.verificationStats.total > 0 && (
              <VerificationProgress
                reviewed={annotationData.verificationStats.total - annotationData.verificationStats.unverified}
                total={annotationData.verificationStats.total}
              />
            )}
            <span className="text-sm text-muted-foreground tabular-nums">
              {annotationData.currentIndex + 1} de {annotationData.totalImages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={!annotationData.prevImageId || loading}
              onClick={() => annotationData.prevImageId && loadImage(annotationData.prevImageId)}
            >
              Anterior
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!annotationData.nextImageId || loading}
              onClick={() => annotationData.nextImageId && loadImage(annotationData.nextImageId)}
            >
              Siguiente
            </Button>
          </div>
        </div>

        {/* Annotation area fills the rest */}
        <div className="flex-1 min-h-0 p-3">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <ImageAnnotationClient
              key={annotationData.image.id}
              src={`/api/ct-images/${image.id}?size=full`}
              alt={image.filename}
              boxes={annotationData.boxes}
              detections={annotationData.detections}
              speciesList={annotationData.speciesList}
              frequentSpecies={annotationData.frequentSpecies}
              jobId={jobId}
              imageId={image.id}
              prevImageId={annotationData.prevImageId}
              nextImageId={annotationData.nextImageId}
              navigationIds={navigationIds ?? undefined}
              confirmedBlank={image.confirmedBlank}
              starred={image.starred}
              starredBy={image.starredBy}
              setupTag={image.setupTag}
              onNavigate={loadImage}
              onBack={handleBack}
              containerClassName="h-full"
              onMutate={handleMutate}
            />
          )}
        </div>
      </div>
    );
  }

  // Grid view (with loading overlay when transitioning to annotation)
  return (
    <div className="relative">
      {loading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60 rounded-lg">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}
      <ResultsClient
        images={images}
        jobId={jobId}
        speciesList={speciesList}
        onImageClick={loadImage}
        onFilteredIdsChange={handleFilteredIdsChange}
      />
    </div>
  );
}

function VerificationProgress({ reviewed, total }: { reviewed: number; total: number }) {
  const pct = Math.round((reviewed / total) * 100);
  const isComplete = reviewed === total;

  return (
    <div className="flex items-center gap-2">
      <div className="w-24 h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${isComplete ? "bg-emerald-500" : "bg-blue-500"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-xs tabular-nums ${isComplete ? "text-emerald-600 font-medium" : "text-muted-foreground"}`}>
        {reviewed}/{total} revisadas
      </span>
    </div>
  );
}
