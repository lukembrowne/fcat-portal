"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";

export interface ImageGridItem {
  id: number;
  filename: string;
  path: string;
  status: string;
  thumbnailPath: string | null;
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

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
      {images.map((img) => (
        <ImageCard key={img.id} image={img} jobId={jobId} />
      ))}
    </div>
  );
}

function ImageCard({ image, jobId }: { image: ImageGridItem; jobId: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

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

  const thumbUrl = `/api/images${image.path}?size=thumb`;
  const topSpecies = image.detections[0];

  return (
    <Link href={`/camera-trap/results/${jobId}/images/${image.id}`}>
      <div
        ref={ref}
        className="group relative aspect-[4/3] rounded-lg overflow-hidden border bg-muted cursor-pointer hover:ring-2 hover:ring-primary transition-all"
      >
        {isVisible ? (
          <img
            src={thumbUrl}
            alt={image.filename}
            className="w-full h-full object-cover"
            loading="lazy"
          />
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
