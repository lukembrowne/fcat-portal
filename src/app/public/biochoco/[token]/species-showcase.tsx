"use client";

import type { SiteSpecies } from "@/app/biochoco/resultados/types";
import {
  sortSpeciesForTable,
  speciesCommonName,
  buildSpeciesStatsText,
} from "@/lib/landowner/copy";
import { FormatSpeciesContent } from "@/lib/landowner/format-species-content";
import { Expand } from "lucide-react";

interface SpeciesShowcaseProps {
  species: SiteSpecies[];
  /** Token-gated image URL builder (same one the rest of the page uses). */
  resolveImageUrl: (id: number, size: "thumb" | "large") => string;
  /** Full-page gallery URL — used as the no-JS / right-click fallback href. */
  speciesHref: (speciesName: string) => string;
  /** Open the swipe lightbox over a species' resolved gallery ids (one click). */
  onTapPhoto: (ids: number[], tappedId: number) => void;
}

/**
 * "Quiénes viven aquí" — one stacked CARD per species recorded at the site
 * (sorted most-at-risk first). Each card shows one photo as a banner on top,
 * then the species' name with its detection count (registros) on the same line,
 * and the shared contextual text below. Tapping a photographed card opens the
 * swipe lightbox over that species' curated photos in ONE click (Compartir +
 * Descargar inside). The card stays an `<a>` to the full-page gallery so no-JS /
 * right-click / open-in-new-tab still work — JS intercepts the click. Species
 * without a photo render but aren't tappable.
 */
export function SpeciesShowcase({
  species,
  resolveImageUrl,
  speciesHref,
  onTapPhoto,
}: SpeciesShowcaseProps) {
  if (species.length === 0) return null;
  const rows = sortSpeciesForTable(species);
  const statsText = buildSpeciesStatsText(species);

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <p className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em] text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
          Quiénes viven aquí
        </p>
        <p className="text-xs text-muted-foreground">{statsText}</p>
      </div>

      <div className="space-y-3">
        {rows.map((sp) => {
          const name = speciesCommonName(sp);
          const galleryIds = sp.galleryImageIds ?? [];
          const hasPhoto = sp.photoImageId != null && galleryIds.length > 0;
          const detText = `${sp.detectionCount} ${
            sp.detectionCount === 1 ? "registro" : "registros"
          }`;
          const content = sp.publicContent?.trim();

          const photo = hasPhoto ? (
            <div className="relative aspect-[16/9] w-full overflow-hidden bg-muted">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={resolveImageUrl(sp.photoImageId as number, "large")}
                alt={name}
                className="h-full w-full object-cover"
                loading="lazy"
              />
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">
                <span className="rounded-full bg-black/55 p-2 text-white backdrop-blur">
                  <Expand className="h-5 w-5" />
                </span>
              </span>
            </div>
          ) : null;

          const info = (
            <div className="flex-1 space-y-1 p-3.5">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-base font-bold leading-tight tracking-tight">
                  {name}
                </h3>
                <span className="shrink-0 whitespace-nowrap text-xs font-medium tabular-nums text-muted-foreground">
                  {detText}
                </span>
              </div>
              <p className="font-serif text-xs italic leading-tight text-muted-foreground">
                {sp.speciesName}
              </p>
              {content && (
                <div className="space-y-1.5 pt-0.5 text-sm leading-snug text-foreground/75">
                  <FormatSpeciesContent text={content} />
                </div>
              )}
            </div>
          );

          const rowClass =
            "flex flex-col overflow-hidden rounded-2xl border bg-card shadow-sm";

          return hasPhoto ? (
            <a
              key={sp.speciesName}
              href={speciesHref(sp.speciesName)}
              aria-label={`Ver fotos de ${name}`}
              onClick={(e) => {
                // One-click lightbox with JS; the href remains the no-JS /
                // right-click / open-in-new-tab fallback.
                e.preventDefault();
                onTapPhoto(galleryIds, galleryIds[0]);
              }}
              className={`group ${rowClass} transition hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary`}
            >
              {photo}
              {info}
            </a>
          ) : (
            <div key={sp.speciesName} className={rowClass}>
              {info}
            </div>
          );
        })}
      </div>
    </section>
  );
}
