"use client";

/**
 * Full-screen, mobile-first swipe gallery for a SINGLE species' photos.
 *
 * Opened inline from the "Quiénes viven aquí" carousel (a card tap) instead of
 * navigating to the `especies/[slug]` sub-route. On mount it lazy-loads the
 * species' token-gated images via `fetchSpeciesImagesByToken`, then renders them
 * in a horizontally scroll-snap track: native touch swipe on phones, scroll /
 * drag on desktop, one `object-contain` image per view over a dark backdrop.
 *
 * Closes on backdrop click, the X button, and Escape. Body scroll is locked
 * while open. Respects `prefers-reduced-motion` (no smooth-scroll animation).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { PhotoShareButton } from "@/components/photo-share-button";
import {
  fetchSpeciesImagesByToken,
  type SpeciesImageRow,
} from "@/app/biochoco/resultados/actions";
import type { SiteSpecies } from "@/app/biochoco/resultados/types";

interface SpeciesLightboxProps {
  token: string;
  species: SiteSpecies;
  resolveImageUrl: (id: number, size: "thumb" | "large") => string;
  onClose: () => void;
}

const GALLERY_PAGE_SIZE = 60;

export function SpeciesLightbox({
  token,
  species,
  resolveImageUrl,
  onClose,
}: SpeciesLightboxProps) {
  const [images, setImages] = useState<SpeciesImageRow[] | null>(null);
  const [current, setCurrent] = useState(0);
  const trackRef = useRef<HTMLDivElement | null>(null);

  const displayName =
    species.spanishName || species.commonName || species.speciesName;

  // Lazy-load this species' images once on mount.
  useEffect(() => {
    let active = true;
    setImages(null);
    fetchSpeciesImagesByToken(token, species.speciesName, 1, GALLERY_PAGE_SIZE)
      .then((res) => {
        if (active) setImages(res?.images ?? []);
      })
      .catch(() => {
        if (active) setImages([]);
      });
    return () => {
      active = false;
    };
  }, [token, species.speciesName]);

  // Close on Escape + lock body scroll while open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  // Track which snapped image is centered for the "N / M" counter.
  const onScroll = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    const idx = Math.round(el.scrollLeft / el.clientWidth);
    setCurrent((prev) => (prev === idx ? prev : idx));
  }, []);

  const total = images?.length ?? 0;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/95 text-white"
      role="dialog"
      aria-modal="true"
      aria-label={`Fotos de ${displayName}`}
      onClick={onClose}
    >
      {/* Header */}
      <div
        className="flex items-start justify-between gap-3 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="min-w-0">
          <h2 className="truncate text-lg font-extrabold leading-tight tracking-tight">
            {displayName}
          </h2>
          <p className="truncate font-serif text-sm italic text-white/75">
            {species.speciesName}
          </p>
        </div>
        <div className="flex flex-none items-center gap-3">
          {total > 0 && (
            <span className="text-xs font-semibold tabular-nums text-white/80">
              {Math.min(current + 1, total)} / {total}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-white/10 p-2 hover:bg-white/20"
            aria-label="Cerrar"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div
        className="relative flex-1 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {images === null ? (
          <div className="flex h-full items-center justify-center">
            <span className="h-8 w-8 animate-spin rounded-full border-2 border-white/25 border-t-white" />
          </div>
        ) : images.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <p className="text-sm text-white/70">
              No hay fotos disponibles de esta especie por ahora.
            </p>
          </div>
        ) : (
          <div
            ref={trackRef}
            onScroll={onScroll}
            className="flex h-full snap-x snap-mandatory overflow-x-auto overflow-y-hidden scroll-smooth motion-reduce:scroll-auto [&::-webkit-scrollbar]:hidden"
          >
            {images.map((img) => {
              const largeUrl = resolveImageUrl(img.id, "large");
              return (
                <div
                  key={img.id}
                  className="relative flex h-full w-full flex-none snap-center items-center justify-center"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={largeUrl}
                    alt={displayName}
                    className="max-h-full max-w-full object-contain select-none"
                    loading="lazy"
                    draggable={false}
                  />
                  <PhotoShareButton
                    imagePath={largeUrl}
                    caption={`${displayName} — registrado en mi finca. Monitoreo FCAT BioChoco`}
                    variant="overlay"
                    className="absolute right-3 top-3 z-10"
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
