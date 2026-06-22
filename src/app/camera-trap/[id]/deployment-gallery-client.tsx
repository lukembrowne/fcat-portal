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
  canEdit?: boolean;
}

export function DeploymentGalleryClient({
  images,
  jobId,
  deploymentId,
  speciesList,
  deploymentName,
  canEdit = true,
}: DeploymentGalleryClientProps) {
  const router = useRouter();

  // --- Overlay state ---
  // `currentImageId` is the user's *intent* — what they pressed → toward.
  // It updates synchronously on every navigation.
  // `displayedPayload` is what's actually rendered; it lags behind on a
  // cache miss so the user keeps seeing the previous image (with a small
  // spinner overlay) instead of a full-screen white flash.
  const [currentImageId, setCurrentImageId] = useState<number | null>(null);
  const [displayedPayload, setDisplayedPayload] = useState<ImagePayload | null>(null);
  const [sessionContext, setSessionContext] = useState<SessionContext | null>(null);
  const [direction, setDirection] = useState<PrefetchDirection>("forward");
  const [coldOpenLoading, setColdOpenLoading] = useState(false);

  // Mirror of `currentImageId` accessible from inside async fetch
  // callbacks so a slow response for an image the user has already
  // navigated past doesn't overwrite the displayed payload (stale-fetch
  // guard).
  const currentImageIdRef = useRef<number | null>(null);
  useEffect(() => {
    currentImageIdRef.current = currentImageId;
  }, [currentImageId]);

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
  // Sized above the prefetch window (8 ahead + 1 behind + current = 10) so
  // just-cached payloads survive a direction flip instead of being evicted.
  const cacheRef = useRef<AnnotationPayloadCache<ImagePayload>>(
    new AnnotationPayloadCache<ImagePayload>(16),
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

      // Cache hit → synchronous swap, no spinner. The displayed payload
      // updates in the same render as the keypress.
      const cached = cacheRef.current.get(imageId);
      if (cached && !isColdOpen) {
        setCurrentImageId(imageId);
        setDisplayedPayload(cached);
        return;
      }

      // Cache miss. Show the full-screen spinner only on a cold open
      // (no payload has ever been displayed yet). For in-overlay
      // navigation we keep the previous payload rendered and let
      // ImageAnnotationClient draw a spinner over just the image area
      // via its `loadingOverlay` prop.
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
          setDisplayedPayload(null);
          return;
        }
        cacheRef.current.set(imageId, payload);
        // Stale-fetch guard: only swap the displayed payload if the user
        // is still on this image. Otherwise just leave it in the cache
        // for the next visit.
        if (currentImageIdRef.current === imageId) {
          setDisplayedPayload(payload);
        }
        if (ctx) setSessionContext(ctx);
      } finally {
        setColdOpenLoading(false);
      }
    },
    [currentImageId, navigationIds, sessionContext, jobId, deploymentId],
  );

  const handleBack = useCallback(() => {
    setCurrentImageId(null);
    setDisplayedPayload(null);
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
      // Same stale-fetch guard as loadImage.
      if (currentImageIdRef.current === currentImageId) {
        setDisplayedPayload(payload);
      }
    }
    if (ctx) setSessionContext(ctx);
  }, [currentImageId, jobId, deploymentId, navigationIds]);

  // --- Prefetch wiring ---
  // Mid-res tier (~1920px) for fast flipping — full-res stays for export/training.
  const buildImageUrl = useCallback(
    (id: number) => `/api/ct-images/${id}?size=annotate`,
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
    ahead: 8,
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

    // The displayed payload may briefly lag behind currentImageId on a
    // cache miss. While that's true we paint a spinner overlay just on
    // the image area (not the whole screen) via ImageAnnotationClient's
    // `loadingOverlay` prop. The very first cold open has no displayed
    // payload at all, so we fall back to a centered loader for that
    // single moment.
    const isLoadingNew =
      displayedPayload != null && displayedPayload.image.id !== currentImageId;
    const showColdSpinner =
      coldOpenLoading || sessionContext == null || displayedPayload == null;
    const headerImage = displayedPayload?.image ?? null;
    const headerName = displayedPayload?.deploymentName ?? deploymentName;

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
            {displayedPayload?.timestamp && (
              <span className="text-xs text-muted-foreground hidden md:inline">
                {displayedPayload.timestamp}
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
          {showColdSpinner ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <ImageAnnotationClient
              // Key on the displayed image (not currentImageId) so the
              // component doesn't remount mid-load — keeping local state
              // (selectedBoxId, zoom, etc.) intact for the visible image.
              key={displayedPayload!.image.id}
              src={`/api/ct-images/${displayedPayload!.image.id}?size=annotate`}
              alt={displayedPayload!.image.filename}
              boxes={displayedPayload!.boxes}
              detections={displayedPayload!.detections}
              speciesList={sessionContext!.speciesList}
              hotkeySlots={sessionContext!.hotkeySlots}
              jobId={jobId}
              // imageId stays in sync with the rendered payload so any
              // action (verify/reject/delete) targets the visible image.
              imageId={displayedPayload!.image.id}
              // Prev/next, however, are computed from the user's intent
              // (`currentImageId`) so a second arrow press during a slow
              // load advances correctly instead of looping back.
              prevImageId={prevImageId}
              nextImageId={nextImageId}
              navigationIds={navigationIds ?? undefined}
              confirmedBlank={displayedPayload!.image.confirmedBlank}
              starred={displayedPayload!.image.starred}
              starredBy={displayedPayload!.image.starredBy}
              setupTag={displayedPayload!.image.setupTag}
              canEdit={canEdit}
              onNavigate={loadImage}
              onBack={handleBack}
              containerClassName="h-full"
              onMutate={handleMutate}
              loadingOverlay={isLoadingNew}
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
