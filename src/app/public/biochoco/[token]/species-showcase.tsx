import type { SiteSpecies } from "@/app/biochoco/resultados/types";
import { iucnChip } from "@/lib/landowner/iucn-chip";
import {
  sortSpeciesForTable,
  speciesCommonName,
  buildSpeciesStatsText,
} from "@/lib/landowner/copy";
import { Bird, PawPrint, ArrowRight } from "lucide-react";

interface SpeciesShowcaseProps {
  species: SiteSpecies[];
  /** Token-gated image URL builder (same one the rest of the page uses). */
  resolveImageUrl: (id: number, size: "thumb" | "large") => string;
  /** Link to a species' full-page photo gallery; only cards with a photo link. */
  speciesHref: (speciesName: string) => string;
}

function TypeIcon({ type }: { type: string | null }) {
  if (type === "bird")
    return <Bird className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />;
  if (type === "mammal")
    return (
      <PawPrint className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
    );
  return null;
}

/**
 * The single, imagery-forward species section of the public landowner page —
 * the merge of the old "Quiénes viven aquí" swipe carousel and the "Todas las
 * especies" table. It shows EVERY species recorded at the site (photographed or
 * not), sorted most-at-risk first, as a responsive card grid: one column on
 * phones, two/three on wider screens.
 *
 * Each card leads with a prominent species photo (name + scientific name + IUCN
 * chip overlaid on a scrim, carousel-style) and a detection count. Cards for
 * species that HAVE photos are a single tap target that navigates to the
 * full-page `especies/[slug]` gallery — the good viewer with clear Descargar /
 * Compartir, zoom, and arrows — so there is no fragile on-page lightbox. Species
 * with no photo render (completeness) but are not tappable.
 *
 * Server-renderable: it's links + images with no client state.
 */
export function SpeciesShowcase({
  species,
  resolveImageUrl,
  speciesHref,
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

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((sp) => {
          const name = speciesCommonName(sp);
          const chip = iucnChip(sp.iucnStatus);
          const hasPhoto = sp.photoImageId != null;
          const detText = `${sp.detectionCount} ${
            sp.detectionCount === 1 ? "registro" : "registros"
          }`;

          const media = (
            <div className="relative aspect-[4/3] w-full overflow-hidden bg-muted text-white">
              {hasPhoto ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={resolveImageUrl(sp.photoImageId as number, "large")}
                    alt={name}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent" />
                  <div className="absolute inset-x-0 bottom-0 space-y-1 p-3.5">
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
                </>
              ) : (
                // No photo: neutral card that still names the species.
                <div className="flex h-full flex-col justify-end p-3.5 text-foreground">
                  {chip && (
                    <span
                      className="mb-1 inline-flex w-fit items-center rounded-full px-2.5 py-0.5 text-[11px] font-bold text-white shadow-sm"
                      style={{ backgroundColor: chip.color }}
                    >
                      {chip.label}
                    </span>
                  )}
                  <h3 className="text-lg font-extrabold leading-tight tracking-tight">
                    {name}
                  </h3>
                  <p className="font-serif text-sm italic leading-tight text-muted-foreground">
                    {sp.speciesName}
                  </p>
                </div>
              )}
            </div>
          );

          const footer = (
            <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 text-xs">
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <TypeIcon type={sp.taxonomicType} />
                <span className="tabular-nums">{detText}</span>
              </span>
              {hasPhoto && (
                <span className="inline-flex items-center gap-1 font-semibold text-emerald-700 dark:text-emerald-400">
                  Ver fotos
                  <ArrowRight className="h-3.5 w-3.5" />
                </span>
              )}
            </div>
          );

          const cardClass =
            "block overflow-hidden rounded-2xl border bg-card shadow-sm transition";

          return hasPhoto ? (
            <a
              key={sp.speciesName}
              href={speciesHref(sp.speciesName)}
              aria-label={`Ver fotos de ${name}`}
              className={`${cardClass} hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary`}
            >
              {media}
              {footer}
            </a>
          ) : (
            <div key={sp.speciesName} className={cardClass}>
              {media}
              {footer}
            </div>
          );
        })}
      </div>
    </section>
  );
}
