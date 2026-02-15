"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";

export interface ImageGridItem {
  id: number;
  filename: string;
  path: string | null;
  status: string;
  thumbnailPath: string | null;
  videoId?: number | null;
  frameIndex?: number | null;
  videoFilename?: string | null;
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
  jobId: number;
}

export function ImageGrid({ images, jobId }: ImageGridProps) {
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
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {standaloneImages.map((img) => (
              <ImageCard key={img.id} image={img} jobId={jobId} />
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
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {group.frames.map((img) => (
              <ImageCard key={img.id} image={img} jobId={jobId} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ImageCard({ image, jobId }: { image: ImageGridItem; jobId: number }) {
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

  return (
    <Link href={`/camera-trap/results/${jobId}/images/${image.id}`}>
      <div
        ref={ref}
        className="group relative aspect-[4/3] rounded-lg overflow-hidden border bg-muted cursor-pointer hover:ring-2 hover:ring-primary transition-all"
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
              className="bg-white/90 text-xs truncate max-w-full"
            >
              {topSpecies.species}{" "}
              {topSpecies.confidence != null &&
                `${(topSpecies.confidence * 100).toFixed(0)}%`}
            </Badge>
          </div>
        )}

        {image.detections.length > 1 && (
          <div className="absolute top-2 right-2">
            <Badge className="bg-primary/90 text-xs">
              {image.detections.length} detecciones
            </Badge>
          </div>
        )}

        {image.status === "processed" && image.detections.length === 0 && (
          <div className="absolute top-2 right-2">
            <Badge variant="outline" className="bg-white/80 text-xs">
              Vacía
            </Badge>
          </div>
        )}

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
      </div>
    </Link>
  );
}
