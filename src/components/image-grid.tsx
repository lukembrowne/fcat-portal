"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Badge } from "@/components/ui/badge";

const GRID_CLASSES: Record<number, string> = {
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-2 md:grid-cols-3",
  4: "grid-cols-2 md:grid-cols-3 lg:grid-cols-4",
  6: "grid-cols-3 md:grid-cols-4 lg:grid-cols-6",
};

export interface ImageGridItem {
  id: number;
  filename: string;
  path: string | null;
  status: string;
  thumbnailPath: string | null;
  videoId?: number | null;
  frameIndex?: number | null;
  videoFilename?: string | null;
  confirmedBlank?: boolean;
  starred?: boolean;
  setupTag?: string | null;
  detections: {
    id: number;
    species: string | null;
    confidence: number | null;
    detectionConfidence: number;
    verificationStatus?: string;
  }[];
}

interface ImageGridProps {
  images: ImageGridItem[];
  jobId?: number;
  basePath?: string;
  selectable?: boolean;
  selectedIds?: Set<number>;
  onToggleSelect?: (id: number) => void;
  columns?: number;
}

export function ImageGrid({ images, jobId, basePath, selectable, selectedIds, onToggleSelect, columns = 4 }: ImageGridProps) {
  const pathname = usePathname();
  const gridClass = GRID_CLASSES[columns] ?? GRID_CLASSES[4];

  // Restore scroll position on mount.
  // The sidebar is position:fixed and SidebarProvider uses min-h-svh,
  // so the window is the actual scroll container (not <main>).
  // Polls via rAF because after revalidatePath the Router Cache is
  // invalidated and the grid re-fetches through Suspense, so content
  // may not be rendered yet when this effect first runs.
  useEffect(() => {
    const key = `grid-scroll:${pathname}`;
    const saved = sessionStorage.getItem(key);
    if (!saved) return;
    const scrollY = parseInt(saved, 10);

    let cancelled = false;
    let attempts = 0;
    let settled = 0;
    const tryRestore = () => {
      if (cancelled) return;
      if (Math.abs(window.scrollY - scrollY) >= 5) {
        window.scrollTo(0, scrollY);
        settled = 0;
      } else if (++settled >= 3) {
        sessionStorage.removeItem(key);
        return;
      }
      if (++attempts < 120) requestAnimationFrame(tryRestore);
      else sessionStorage.removeItem(key);
    };
    requestAnimationFrame(tryRestore);

    return () => { cancelled = true; };
  }, [pathname]);

  // Save scroll position before navigating to an image
  const saveScroll = useCallback(() => {
    sessionStorage.setItem(`grid-scroll:${pathname}`, String(window.scrollY));
  }, [pathname]);

  if (images.length === 0) {
    return (
      <p className="text-muted-foreground text-center py-8">
        No hay imágenes para mostrar.
      </p>
    );
  }

  // Group images: standalone images first, then video frame groups
  const standaloneImages = images.filter((img) => !img.videoId);
  const videoGroups = new Map<number, { filename: string; frames: ImageGridItem[] }>();

  for (const img of images) {
    if (img.videoId) {
      const group = videoGroups.get(img.videoId) || {
        filename: img.videoFilename || "Video",
        frames: [],
      };
      group.frames.push(img);
      videoGroups.set(img.videoId, group);
    }
  }

  // Sort frames within each group by frameIndex
  for (const group of videoGroups.values()) {
    group.frames.sort((a, b) => (a.frameIndex ?? 0) - (b.frameIndex ?? 0));
  }

  const hasVideoGroups = videoGroups.size > 0;

  return (
    <div className="space-y-6">
      {standaloneImages.length > 0 && (
        <div>
          {hasVideoGroups && (
            <h3 className="text-sm font-medium text-muted-foreground mb-2">
              Imágenes ({standaloneImages.length})
            </h3>
          )}
          <div className={`grid ${gridClass} gap-3`}>
            {standaloneImages.map((img) => (
              <ImageCard
                key={img.id}
                image={img}
                jobId={jobId}
                basePath={basePath}
                selectable={selectable}
                selected={selectedIds?.has(img.id)}
                onToggleSelect={onToggleSelect}
                onBeforeNavigate={saveScroll}
              />
            ))}
          </div>
        </div>
      )}
      {[...videoGroups.entries()].map(([videoId, group]) => (
        <div key={videoId}>
          <h3 className="text-sm font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
            <svg className="size-4 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
            </svg>
            {group.filename} ({group.frames.length} cuadros)
          </h3>
          <div className={`grid ${gridClass} gap-3`}>
            {group.frames.map((img) => (
              <ImageCard
                key={img.id}
                image={img}
                jobId={jobId}
                basePath={basePath}
                selectable={selectable}
                selected={selectedIds?.has(img.id)}
                onToggleSelect={onToggleSelect}
                onBeforeNavigate={saveScroll}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ImageCard({
  image,
  jobId,
  basePath,
  selectable,
  selected,
  onToggleSelect,
  onBeforeNavigate,
}: {
  image: ImageGridItem;
  jobId?: number;
  basePath?: string;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: number) => void;
  onBeforeNavigate?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const thumbUrl = `/api/ct-images/${image.id}?size=thumb`;
  const topSpecies = image.detections[0];
  const href = basePath
    ? `${basePath}/${image.id}`
    : `/camera-trap/results/${jobId}/images/${image.id}`;

  const handleCheckboxClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onToggleSelect?.(image.id);
    },
    [image.id, onToggleSelect],
  );

  const cardContent = (
    <div
      ref={ref}
      className={`group relative aspect-[4/3] rounded-lg overflow-hidden border bg-muted cursor-pointer hover:ring-2 hover:ring-primary transition-all ${
        selected ? "ring-2 ring-blue-500 border-blue-500" : ""
      }`}
    >
      {isVisible && !loadError ? (
        <img
          src={thumbUrl}
          alt={image.filename}
          className="w-full h-full object-cover"
          loading="lazy"
          onError={() => setLoadError(true)}
        />
      ) : loadError ? (
        <div className="w-full h-full flex flex-col items-center justify-center gap-1 text-muted-foreground">
          <svg className="size-8 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0 0 22.5 18.75V5.25A2.25 2.25 0 0 0 20.25 3H3.75A2.25 2.25 0 0 0 1.5 5.25v13.5A2.25 2.25 0 0 0 3.75 21Z" />
          </svg>
          <span className="text-[10px]">Sin vista previa</span>
        </div>
      ) : (
        <div className="w-full h-full bg-muted animate-pulse" />
      )}

      {topSpecies?.species && (
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-2 pt-6">
          <Badge
            variant="secondary"
            className={`text-xs truncate max-w-full ${
              topSpecies.verificationStatus === "verified" || topSpecies.verificationStatus === "corrected"
                ? "bg-blue-100 text-blue-800 border border-blue-300"
                : topSpecies.verificationStatus === "rejected"
                  ? "bg-red-100 text-red-700 border border-red-300"
                  : "bg-white/90"
            }`}
          >
            {topSpecies.species}
            {topSpecies.verificationStatus === "verified" || topSpecies.verificationStatus === "corrected"
              ? " ✓"
              : topSpecies.verificationStatus === "rejected"
                ? " ✗"
                : topSpecies.confidence != null
                  ? ` ${(topSpecies.confidence * 100).toFixed(0)}%`
                  : null}
          </Badge>
        </div>
      )}

      {image.setupTag === "deployment" ? (
        <div className="absolute top-2 right-2">
          <Badge variant="outline" className="bg-blue-50 border-blue-300 text-blue-700 text-xs">
            Instalación
          </Badge>
        </div>
      ) : image.setupTag === "retrieval" ? (
        <div className="absolute top-2 right-2">
          <Badge variant="outline" className="bg-orange-50 border-orange-300 text-orange-700 text-xs">
            Recogida
          </Badge>
        </div>
      ) : image.confirmedBlank ? (
        <div className="absolute top-2 right-2">
          <Badge variant="outline" className="bg-green-50 border-green-300 text-green-700 text-xs">
            Vacía ✓
          </Badge>
        </div>
      ) : image.detections.length > 1 ? (
        <div className="absolute top-2 right-2">
          <Badge className="bg-primary/90 text-xs">
            {image.detections.length} detecciones
          </Badge>
        </div>
      ) : image.status === "processed" && image.detections.length === 0 ? (
        <div className="absolute top-2 right-2">
          <Badge variant="outline" className="bg-white/80 text-xs">
            Vacía
          </Badge>
        </div>
      ) : null}

      {image.status === "failed" && (
        <div className="absolute inset-0 flex items-center justify-center bg-red-500/20">
          <Badge variant="destructive" className="text-xs">
            Fallida
          </Badge>
        </div>
      )}

      <div className="absolute top-0 left-0 right-0 bg-gradient-to-b from-black/50 to-transparent p-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <p className="text-white text-xs truncate">{image.filename}</p>
      </div>

      {image.starred && (
        <div className={`absolute ${selectable ? "top-2 left-8" : "top-2 left-2"} z-10`}>
          <svg
            className="size-5 text-amber-400 drop-shadow"
            fill="currentColor"
            viewBox="0 0 24 24"
          >
            <path d="M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z" />
          </svg>
        </div>
      )}

      {selectable && (
        <div
          className="absolute top-2 left-2 z-20"
          onClick={handleCheckboxClick}
        >
          <div
            className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
              selected
                ? "bg-blue-500 border-blue-500"
                : "bg-white/80 border-gray-400 hover:border-blue-400"
            }`}
          >
            {selected && (
              <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            )}
          </div>
        </div>
      )}
    </div>
  );

  return <Link href={href} onClick={onBeforeNavigate}>{cardContent}</Link>;
}
