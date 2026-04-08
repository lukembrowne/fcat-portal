"use client";

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, ArrowLeft } from "lucide-react";
import { ResultsClient, type ResultsSpeciesEntry } from "../results/[id]/results-client";
import { ImageAnnotationClient } from "../results/[id]/images/[imageId]/image-annotation-client";
import {
  getAnnotationSessionContext,
  getImagePayload,
} from "../actions";
import {
  AnnotationPayloadCache,
  type PrefetchDirection,
} from "@/lib/annotation-prefetch";
import { useAnnotationPrefetch } from "@/hooks/use-annotation-prefetch";
import type { ImageGridItem } from "@/components/image-grid";

type SessionContext = NonNullable<Awaited<ReturnType<typeof getAnnotationSessionContext>>>;
type ImagePayload = NonNullable<Awaited<ReturnType<typeof getImagePayload>>>;

interface DeploymentGalleryClientProps {
  images: ImageGridItem[];
  jobId: number;
  deploymentId: number;
  speciesList: ResultsSpeciesEntry[];
  deploymentName: string;
}

export function DeploymentGalleryClient({
  images,
  jobId,
  deploymentId,
  speciesList,
  deploymentName,
}: DeploymentGalleryClientProps) {
  const router = useRouter();

  // --- Overlay state ---
  const [currentImageId, setCurrentImageId] = useState<number | null>(null);
  const [currentPayload, setCurrentPayload] = useState<ImagePayload | null>(null);
  const [sessionContext, setSessionContext] = useState<SessionContext | null>(null);
  const [direction, setDirection] = useState<PrefetchDirection>("forward");
  const [coldOpenLoading, setColdOpenLoading] = useState(false);

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

  // Stable LRU cache instance — survives across renders, cleared on close.
  const cacheRef = useRef<AnnotationPayloadCache<ImagePayload>>(
    new AnnotationPayloadCache<ImagePayload>(10),
  );

  // Lock body scroll when annotation overlay is open
  useEffect(() => {
    if (currentImageId != null) {
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = "";
      };
    }
  }, [currentImageId]);

  // Open the overlay or navigate within it. On cache hit we swap state
  // synchronously so the next image paints in the same frame as the
  // keypress. On cache miss we kick off a fetch and show a spinner only
  // for cold opens (mid-walk navigation just feels like a tiny stall).
  const loadImage = useCallback(
    async (imageId: number) => {
      // Detect navigation direction relative to the current cursor so the
      // prefetch hook can flip its bias.
      setDirection((prev) => {
        if (currentImageId == null) return "forward";
        const ids = navigationIds ?? filteredIdsRef.current;
        const fromIdx = ids.indexOf(currentImageId);
        const toIdx = ids.indexOf(imageId);
        if (fromIdx === -1 || toIdx === -1) return prev;
        return toIdx >= fromIdx ? "forward" : "backward";
      });

      // First-time open: snapshot the current filtered list and load
      // session context in parallel with the first image's payload.
      const isColdOpen = currentImageId == null;
      let activeNavIds = navigationIds;
      if (isColdOpen) {
        const snapshot =
          filteredIdsRef.current.length > 0 ? [...filteredIdsRef.current] : null;
        activeNavIds = snapshot;
        setNavigationIds(snapshot);
      }

      // Cache hit → synchronous swap, no spinner.
      const cached = cacheRef.current.get(imageId);
      if (cached && !isColdOpen) {
        setCurrentImageId(imageId);
        setCurrentPayload(cached);
        return;
      }

      // Cache miss. Show spinner for cold opens; for in-overlay navigation
      // we keep the previous image painted until the new one resolves so
      // the user doesn't see a flash of empty state.
      if (isColdOpen) setColdOpenLoading(true);
      setCurrentImageId(imageId);

      try {
        const [payload, ctx] = await Promise.all([
          getImagePayload(imageId),
          isColdOpen
            ? getAnnotationSessionContext(jobId, deploymentId, activeNavIds ?? undefined)
            : Promise.resolve(sessionContext),
        ]);
        if (payload == null) {
          // Permission denied or image gone — bail back to the grid.
          setCurrentImageId(null);
          setCurrentPayload(null);
          return;
        }
        cacheRef.current.set(imageId, payload);
        setCurrentPayload(payload);
        if (ctx) setSessionContext(ctx);
      } finally {
        setColdOpenLoading(false);
      }
    },
    [currentImageId, navigationIds, sessionContext, jobId, deploymentId],
  );

  const handleBack = useCallback(() => {
    setCurrentImageId(null);
    setCurrentPayload(null);
    setSessionContext(null);
    setNavigationIds(null);
    cacheRef.current.clear();
    router.refresh();
  }, [router]);

  // Re-fetch the current image's payload after a mutation (verify, reject,
  // species assign, delete). Mutations also affect deployment-wide
  // verification stats and may add a species, so we refetch session
  // context too — but only on mutation, not on every navigation.
  const handleMutate = useCallback(async () => {
    if (currentImageId == null) return;
    cacheRef.current.delete(currentImageId);
    const [payload, ctx] = await Promise.all([
      getImagePayload(currentImageId),
      getAnnotationSessionContext(
        jobId,
        deploymentId,
        navigationIds ?? undefined,
      ),
    ]);
    if (payload) {
      cacheRef.current.set(currentImageId, payload);
      setCurrentPayload(payload);
    }
    if (ctx) setSessionContext(ctx);
  }, [currentImageId, jobId, deploymentId, navigationIds]);

  // --- Prefetch wiring ---
  const buildImageUrl = useCallback(
    (id: number) => `/api/ct-images/${id}?size=full`,
    [],
  );
  const stableNavIds = useMemo(() => navigationIds ?? [], [navigationIds]);

  useAnnotationPrefetch<ImagePayload>({
    currentImageId,
    navigationIds: stableNavIds,
    cache: cacheRef.current,
    fetchPayload: getImagePayload,
    buildImageUrl,
    direction,
    enabled: currentImageId != null && sessionContext != null,
  });

  // --- Render ---

  // Full-viewport annotation overlay
  if (currentImageId != null) {
    const ids = navigationIds ?? [];
    const currentIndex = ids.indexOf(currentImageId);
    const prevImageId = currentIndex > 0 ? ids[currentIndex - 1] : null;
    const nextImageId =
      currentIndex >= 0 && currentIndex < ids.length - 1
        ? ids[currentIndex + 1]
        : null;
    const totalImages = ids.length;

    // Show spinner whenever the rendered payload doesn't match the
    // requested image. Cache hits make this false in the same render
    // cycle as the keypress; misses (cold open or scrolling past the
    // prefetch window) flash a brief spinner until the fetch resolves.
    const payloadMatches =
      currentPayload != null && currentPayload.image.id === currentImageId;
    const showSpinner = coldOpenLoading || sessionContext == null || !payloadMatches;
    const headerImage = payloadMatches ? currentPayload!.image : null;
    const headerName = currentPayload?.deploymentName ?? deploymentName;

    return (
      <div className="fixed inset-0 z-50 bg-background flex flex-col">
        {/* Compact top bar */}
        <div className="flex items-center justify-between px-4 py-2 border-b shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Button variant="ghost" size="sm" onClick={handleBack} className="shrink-0 gap-1.5">
              <ArrowLeft className="h-4 w-4" />
              <span className="hidden sm:inline">{headerName}</span>
            </Button>
            <span className="text-muted-foreground hidden sm:inline">/</span>
            <span className="font-medium text-sm truncate">
              {headerImage?.filename ?? ""}
            </span>
            {payloadMatches && currentPayload?.timestamp && (
              <span className="text-xs text-muted-foreground hidden md:inline">
                {currentPayload.timestamp}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* Verification progress */}
            {sessionContext && sessionContext.verificationStats.total > 0 && (
              <VerificationProgress
                reviewed={
                  sessionContext.verificationStats.total -
                  sessionContext.verificationStats.unverified
                }
                total={sessionContext.verificationStats.total}
              />
            )}
            <span className="text-sm text-muted-foreground tabular-nums">
              Imagen {currentIndex + 1} de {totalImages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={!prevImageId}
              onClick={() => prevImageId && loadImage(prevImageId)}
            >
              Anterior
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!nextImageId}
              onClick={() => nextImageId && loadImage(nextImageId)}
            >
              Siguiente
            </Button>
          </div>
        </div>

        {/* Annotation area fills the rest */}
        <div className="flex-1 min-h-0 p-3">
          {showSpinner ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <ImageAnnotationClient
              key={currentImageId}
              src={`/api/ct-images/${currentImageId}?size=full`}
              alt={headerImage!.filename}
              boxes={currentPayload!.boxes}
              detections={currentPayload!.detections}
              speciesList={sessionContext!.speciesList}
              frequentSpecies={sessionContext!.frequentSpecies}
              jobId={jobId}
              imageId={currentImageId}
              prevImageId={prevImageId}
              nextImageId={nextImageId}
              navigationIds={navigationIds ?? undefined}
              confirmedBlank={headerImage!.confirmedBlank}
              starred={headerImage!.starred}
              starredBy={headerImage!.starredBy}
              setupTag={headerImage!.setupTag}
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
      {coldOpenLoading && (
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
