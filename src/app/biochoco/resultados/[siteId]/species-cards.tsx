"use client";

import Link from "next/link";
import type { SiteSpecies } from "../types";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ConservationBadge } from "@/components/conservation-badge";
import { PhotoShareButton } from "@/components/photo-share-button";
import { Bug, Bird, Squirrel } from "lucide-react";

interface SpeciesCardsProps {
  species: SiteSpecies[];
  totalDetections: number;
  /**
   * Resolves an image ID to a URL. Allows public pages to swap to the
   * token-gated public image API without children learning about it.
   */
  resolveImageUrl?: (imageId: number, size: "thumb" | "large") => string;
  /**
   * Optional href builder per species. If provided, each card becomes a
   * link to its own gallery sub-route. If null/undefined the cards
   * render as static (used by the internal results page for now).
   */
  speciesHref?: ((speciesName: string) => string) | null;
  /**
   * When set (public landowner view), each card's photo gets a share button
   * and this label is woven into the share caption. Omitted internally.
   */
  shareSiteLabel?: string;
}

const TAXONOMIC_LABELS: Record<string, string> = {
  mammal: "Mamífero",
  bird: "Ave",
  reptile: "Reptil",
  amphibian: "Anfibio",
  insect: "Insecto",
};

function TaxonomicIcon({ type }: { type: string | null }) {
  const cls = "h-3.5 w-3.5";
  switch (type) {
    case "bird":
      return <Bird className={cls} />;
    case "mammal":
      return <Squirrel className={cls} />;
    default:
      return <Bug className={cls} />;
  }
}

export function SpeciesCards({
  species,
  totalDetections,
  resolveImageUrl,
  speciesHref,
  shareSiteLabel,
}: SpeciesCardsProps) {
  if (species.length === 0) {
    return (
      <div className="flex items-center justify-center h-[200px] bg-muted rounded-xl">
        <p className="text-muted-foreground">
          No se han verificado identificaciones de especies para este sitio.
        </p>
      </div>
    );
  }

  const buildImageUrl =
    resolveImageUrl ?? ((id) => `/api/ct-images/${id}?size=thumb`);

  // Count unique taxonomic groups
  const groupCounts = new Map<string, number>();
  for (const s of species) {
    const group = s.taxonomicType ?? "unknown";
    groupCounts.set(group, (groupCounts.get(group) ?? 0) + 1);
  }

  return (
    <div className="space-y-4">
      {/* Summary bar */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">
          {species.length} {species.length === 1 ? "especie" : "especies"}
        </span>
        <span>{totalDetections} detecciones</span>
        {Array.from(groupCounts.entries()).map(([group, count]) => (
          <span key={group} className="flex items-center gap-1">
            <TaxonomicIcon type={group} />
            {count} {TAXONOMIC_LABELS[group] ?? group}
          </span>
        ))}
      </div>

      {/* Cards grid */}
      <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
        {species.map((sp) => {
          const cardBody = (
            <Card
              key={sp.speciesName}
              className="overflow-hidden h-full transition-shadow hover:shadow-md"
            >
              {/* Photo */}
              <div className="relative h-40 bg-muted">
                <div className="absolute left-2 top-2 z-10">
                  <ConservationBadge status={sp.iucnStatus} />
                </div>
                {shareSiteLabel && sp.photoImageId && resolveImageUrl && (
                  <div className="absolute right-2 top-2 z-10">
                    <PhotoShareButton
                      imagePath={resolveImageUrl(sp.photoImageId, "large")}
                      caption={`🐾 ${sp.spanishName ?? sp.commonName ?? sp.speciesName} — Monitoreo de biodiversidad FCAT en ${shareSiteLabel}`}
                    />
                  </div>
                )}
                {sp.photoImageId ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={buildImageUrl(sp.photoImageId, "thumb")}
                    alt={sp.speciesName}
                    className="object-cover w-full h-full"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex items-center justify-center h-full">
                    <TaxonomicIcon type={sp.taxonomicType} />
                  </div>
                )}
              </div>

              <CardContent className="p-3 space-y-1.5">
                <div>
                  <p className="font-medium text-sm italic">{sp.speciesName}</p>
                  {(sp.spanishName || sp.commonName) && (
                    <p className="text-xs text-muted-foreground">
                      {sp.spanishName ?? sp.commonName}
                    </p>
                  )}
                </div>

                <div className="flex items-center justify-between">
                  <Badge variant="secondary" className="text-xs">
                    {sp.detectionCount}{" "}
                    {sp.detectionCount === 1 ? "detección" : "detecciones"}
                  </Badge>
                  {sp.taxonomicType && (
                    <Badge variant="outline" className="text-xs gap-1">
                      <TaxonomicIcon type={sp.taxonomicType} />
                      {TAXONOMIC_LABELS[sp.taxonomicType] ?? sp.taxonomicType}
                    </Badge>
                  )}
                </div>
              </CardContent>
            </Card>
          );

          if (speciesHref) {
            const href = speciesHref(sp.speciesName);
            return (
              <Link
                key={sp.speciesName}
                href={href}
                className="block focus:outline-none focus:ring-2 focus:ring-primary rounded-xl"
              >
                {cardBody}
              </Link>
            );
          }
          return cardBody;
        })}
      </div>
    </div>
  );
}
