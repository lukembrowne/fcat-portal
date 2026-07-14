"use client";

/**
 * Client-side image viewer for the public species gallery.
 *
 * The surrounding page (`page.tsx`) is server-rendered and still shows the
 * thumbnail grid and pagination links as plain HTML. This component is a
 * progressive enhancement: it re-renders the same grid with click handlers
 * that open a shadcn Dialog containing a large zoomable view of the image,
 * with prev/next navigation scoped to the current page of images.
 *
 * Zoom: reuses `useImageZoom` (wheel + space-drag pan on desktop) and sets
 * `touch-action: pinch-zoom` on the image wrapper so mobile users get
 * native pinch gestures as well.
 *
 * Download: the in-modal "Descargar" button and the thumbnail corner
 * download icon are both plain <a download> anchors so they keep working
 * even if something breaks in the JS layer.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { useImageZoom } from "@/hooks/use-image-zoom";
import { PhotoShareButton } from "@/components/photo-share-button";
import { Download, ChevronLeft, ChevronRight, X } from "lucide-react";
import type { SpeciesImageRow } from "@/app/biochoco/resultados/actions";

interface GalleryClientProps {
  token: string;
  siteId: string;
  speciesLabel: string;
  images: SpeciesImageRow[];
}

export function GalleryClient({
  token,
  siteId,
  speciesLabel,
  images,
}: GalleryClientProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const openImage = useMemo(
    () => (openIndex != null ? images[openIndex] ?? null : null),
    [openIndex, images]
  );

  const isOpen = openImage !== null;
  const hasPrev = openIndex != null && openIndex > 0;
  const hasNext = openIndex != null && openIndex < images.length - 1;

  const goPrev = useCallback(() => {
    setOpenIndex((i) => (i != null && i > 0 ? i - 1 : i));
  }, []);

  const goNext = useCallback(() => {
    setOpenIndex((i) =>
      i != null && i < images.length - 1 ? i + 1 : i
    );
  }, [images.length]);

  // Keyboard nav while the dialog is open. Escape is handled by Radix.
  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, goPrev, goNext]);

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 sm:gap-3">
        {images.map((img, i) => {
          const thumbUrl = `/api/public/site-images/${token}/${img.id}?size=thumb`;
          const downloadUrl = `/api/public/site-images/${token}/${img.id}?size=large&download=1`;
          return (
            <div
              key={img.id}
              className="relative aspect-[4/3] rounded-lg overflow-hidden bg-muted group"
            >
              <button
                type="button"
                onClick={() => setOpenIndex(i)}
                className="absolute inset-0 w-full h-full cursor-zoom-in focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                aria-label={`Ver imagen ${i + 1} de ${images.length}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={thumbUrl}
                  alt=""
                  loading="lazy"
                  className="object-cover w-full h-full transition-transform group-hover:scale-[1.02]"
                />
              </button>
              <a
                href={downloadUrl}
                download={`FCAT-${siteId}-${img.id}.jpg`}
                onClick={(e) => e.stopPropagation()}
                className="absolute bottom-1.5 right-1.5 z-10 bg-black/50 hover:bg-black/70 text-white p-1.5 rounded-md"
                aria-label="Descargar imagen"
              >
                <Download className="w-4 h-4" />
              </a>
            </div>
          );
        })}
      </div>

      <ImageViewerDialog
        open={isOpen}
        onOpenChange={(open) => {
          if (!open) setOpenIndex(null);
        }}
        token={token}
        siteId={siteId}
        speciesLabel={speciesLabel}
        image={openImage}
        index={openIndex}
        total={images.length}
        hasPrev={hasPrev}
        hasNext={hasNext}
        onPrev={goPrev}
        onNext={goNext}
        onClose={() => setOpenIndex(null)}
      />
    </>
  );
}

interface ImageViewerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: string;
  siteId: string;
  speciesLabel: string;
  image: SpeciesImageRow | null;
  index: number | null;
  total: number;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}

function ImageViewerDialog({
  open,
  onOpenChange,
  token,
  siteId,
  speciesLabel,
  image,
  index,
  total,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  onClose,
}: ImageViewerDialogProps) {
  const {
    containerRef,
    wrapperRef,
    style,
    panHandlers,
    isPanning,
    resetZoom,
  } = useImageZoom({ disabled: !open });

  // Reset zoom whenever the image changes.
  useEffect(() => {
    resetZoom();
  }, [image?.id, resetZoom]);

  if (!image) return null;

  const largeUrl = `/api/public/site-images/${token}/${image.id}?size=large`;
  const downloadUrl = `/api/public/site-images/${token}/${image.id}?size=large&download=1`;
  const humanIndex = index != null ? index + 1 : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-5xl p-0 gap-0 overflow-hidden sm:rounded-lg"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">
          {speciesLabel} — imagen {humanIndex} de {total}
        </DialogTitle>

        {/* Zoomable image area */}
        <div
          ref={containerRef}
          className={`relative bg-black flex items-center justify-center overflow-hidden max-h-[75vh] min-h-[50vh] ${
            isPanning ? "cursor-grab" : ""
          }`}
        >
          <div
            ref={wrapperRef}
            className="max-h-full max-w-full"
            style={{ ...style, touchAction: "pinch-zoom" }}
            {...panHandlers}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={largeUrl}
              alt={image.filename}
              className="max-h-[75vh] w-auto object-contain select-none"
              draggable={false}
            />
          </div>

          {/* Close button (top-right) */}
          <button
            type="button"
            onClick={onClose}
            className="absolute top-2 right-2 z-10 bg-black/60 hover:bg-black/80 text-white rounded-full p-2"
            aria-label="Cerrar"
          >
            <X className="w-4 h-4" />
          </button>

          {/* Prev / next buttons */}
          {hasPrev && (
            <button
              type="button"
              onClick={onPrev}
              className="absolute left-2 top-1/2 -translate-y-1/2 z-10 bg-black/60 hover:bg-black/80 text-white rounded-full p-2"
              aria-label="Imagen anterior"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
          )}
          {hasNext && (
            <button
              type="button"
              onClick={onNext}
              className="absolute right-2 top-1/2 -translate-y-1/2 z-10 bg-black/60 hover:bg-black/80 text-white rounded-full p-2"
              aria-label="Imagen siguiente"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          )}

          {/* Index caption */}
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-10 bg-black/60 text-white text-xs px-2.5 py-1 rounded-full tabular-nums">
            {humanIndex} / {total}
          </div>
        </div>

        {/* Footer: filename + share + download */}
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-t bg-background">
          <p className="text-xs text-muted-foreground truncate">
            {image.filename}
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <PhotoShareButton
              variant="button"
              imagePath={largeUrl}
              caption={`🐾 ${speciesLabel} — Monitoreo de biodiversidad FCAT en ${siteId}`}
            />
            <a
              href={downloadUrl}
              download={`FCAT-${siteId}-${image.id}.jpg`}
              className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              Descargar
            </a>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
