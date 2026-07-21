"use client";

import { useState } from "react";
import type { SiteSpecies } from "@/app/biochoco/resultados/types";
import { PhotoShareButton } from "@/components/photo-share-button";
import { iucnChip } from "@/lib/landowner/iucn-chip";
import { ArrowRight } from "lucide-react";
import { SpeciesLightbox } from "./species-lightbox";

interface SpeciesCarouselProps {
  species: SiteSpecies[];
  token: string;
  resolveImageUrl: (id: number, size: "thumb" | "large") => string;
}

/** Compact one-line stats caption under the carousel heading. */
export function buildSpeciesStatsText(species: SiteSpecies[]): string {
  const speciesCount = species.length;
  const detections = species.reduce((sum, s) => sum + s.detectionCount, 0);
  const birds = species.filter((s) => s.taxonomicType === "bird").length;
  const mammals = species.filter((s) => s.taxonomicType === "mammal").length;

  const parts = [
    `${speciesCount} ${speciesCount === 1 ? "especie" : "especies"}`,
    `${detections} ${detections === 1 ? "detección" : "detecciones"}`,
  ];
  if (birds > 0) parts.push(`${birds} ${birds === 1 ? "ave" : "aves"}`);
  if (mammals > 0)
    parts.push(`${mammals} ${mammals === 1 ? "mamífero" : "mamíferos"}`);

  return parts.join(" · ");
}

/**
 * Horizontal scroll-snap "feed" of the species photographed at the site. Native
 * touch swipe on phones, scroll/drag on desktop. Each card is a token-gated
 * species photo with the common + scientific name, an optional IUCN chip, and a
 * per-photo share button. Tapping a card opens an inline swipeable gallery
 * (`SpeciesLightbox`) of THAT species' photos — no navigation. Species without a
 * photo are skipped; if none have a photo the section renders nothing.
 */
export function SpeciesCarousel({
  species,
  token,
  resolveImageUrl,
}: SpeciesCarouselProps) {
  const [selected, setSelected] = useState<SiteSpecies | null>(null);
  const withPhotos = species.filter((s) => s.photoImageId != null);
  if (withPhotos.length === 0) return null;

  const statsText = buildSpeciesStatsText(species);

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="space-y-1">
          <p className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em] text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            Quiénes viven aquí
          </p>
          <p className="text-xs text-muted-foreground">{statsText}</p>
        </div>
        <span
          aria-hidden
          className="inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground motion-safe:animate-[fcat-swipe-hint_1.6s_ease-in-out_infinite]"
        >
          Deslice
          <ArrowRight className="h-3.5 w-3.5" />
        </span>
      </div>

      <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 [&::-webkit-scrollbar]:hidden sm:mx-0 sm:px-0">
        {withPhotos.map((sp) => {
          const name =
            sp.spanishName || sp.commonName || sp.speciesName;
          const chip = iucnChip(sp.iucnStatus);
          const imageUrl = resolveImageUrl(sp.photoImageId as number, "large");
          return (
            <div
              key={sp.speciesName}
              className="relative aspect-[3/4] shrink-0 basis-[78%] snap-center overflow-hidden rounded-2xl bg-muted text-white sm:basis-[46%] lg:basis-[31%]"
            >
              <button
                type="button"
                onClick={() => setSelected(sp)}
                className="absolute inset-0 block w-full text-left"
                aria-label={`Ver fotos de ${name}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={imageUrl}
                  alt={name}
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent" />
                <div className="absolute inset-x-0 bottom-0 space-y-1.5 p-4">
                  {chip && (
                    <span
                      className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-bold text-white shadow-sm"
                      style={{ backgroundColor: chip.color }}
                    >
                      {chip.label}
                    </span>
                  )}
                  <h3 className="text-lg font-extrabold leading-tight tracking-tight drop-shadow-md">
                    {name}
                  </h3>
                  <p className="font-serif text-sm italic leading-tight text-white/85 drop-shadow">
                    {sp.speciesName}
                  </p>
                </div>
              </button>
              <PhotoShareButton
                imagePath={imageUrl}
                caption={`${name} — registrado en mi finca. Monitoreo FCAT BioChoco`}
                variant="overlay"
                className="absolute right-2.5 top-2.5 z-10"
              />
            </div>
          );
        })}
      </div>

      {selected && (
        <SpeciesLightbox
          token={token}
          species={selected}
          resolveImageUrl={resolveImageUrl}
          onClose={() => setSelected(null)}
        />
      )}

      <style>{`
        @keyframes fcat-swipe-hint {
          0%, 100% { transform: translateX(0); }
          50% { transform: translateX(4px); }
        }
      `}</style>
    </section>
  );
}
