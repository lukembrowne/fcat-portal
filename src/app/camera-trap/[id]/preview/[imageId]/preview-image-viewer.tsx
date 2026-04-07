"use client";

import { useEffect, useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

interface PreviewImageViewerProps {
  src: string;
  alt: string;
  deploymentId: number;
  deploymentName: string | null;
  filename: string;
  timestamp?: string | null;
  prevImageId: number | null;
  nextImageId: number | null;
  currentIndex: number;
  totalImages: number;
  children?: React.ReactNode;
}

export function PreviewImageViewer({
  src,
  alt,
  deploymentId,
  deploymentName,
  filename,
  timestamp,
  prevImageId,
  nextImageId,
  currentIndex,
  totalImages,
  children,
}: PreviewImageViewerProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [imageLoaded, setImageLoaded] = useState(false);

  // Reset image loaded state when src changes
  useEffect(() => {
    setImageLoaded(false);
  }, [src]);

  const navigateTo = useCallback(
    (imageId: number) => {
      startTransition(() => {
        router.push(`/camera-trap/${deploymentId}/preview/${imageId}`);
      });
    },
    [router, deploymentId]
  );

  const goNext = useCallback(() => {
    if (nextImageId != null) navigateTo(nextImageId);
  }, [nextImageId, navigateTo]);

  const goPrev = useCallback(() => {
    if (prevImageId != null) navigateTo(prevImageId);
  }, [prevImageId, navigateTo]);

  // Arrow key navigation
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Skip when focused on editable fields
      const target = e.target as HTMLElement;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target.isContentEditable
      ) {
        return;
      }

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [goNext, goPrev]);

  return (
    <>
      {/* Header with navigation */}
      <div className="flex items-center justify-between mb-4">
        <div className="min-w-0">
          {deploymentName && (
            <p className="text-sm text-muted-foreground truncate">
              {deploymentName}
            </p>
          )}
          <h1 className="text-xl font-bold truncate">{filename}</h1>
          {timestamp && (
            <p className="text-sm text-muted-foreground">{timestamp}</p>
          )}
          {children}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground tabular-nums">
            Imagen {currentIndex + 1} de {totalImages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={prevImageId == null || isPending}
            onClick={goPrev}
          >
            Anterior
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={nextImageId == null || isPending}
            onClick={goNext}
          >
            Siguiente
          </Button>
        </div>
      </div>

      {/* Full-size image */}
      <div className="relative bg-muted rounded-lg overflow-hidden">
        {(!imageLoaded || isPending) && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        )}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          className={`w-full h-auto transition-opacity duration-200 ${
            imageLoaded && !isPending ? "opacity-100" : "opacity-0"
          }`}
          onLoad={() => setImageLoaded(true)}
        />
      </div>
    </>
  );
}
