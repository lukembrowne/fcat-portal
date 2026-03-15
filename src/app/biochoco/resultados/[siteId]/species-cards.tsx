"use client";

import type { SiteSpecies } from "../types";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Bug, Bird, Squirrel } from "lucide-react";

interface SpeciesCardsProps {
  species: SiteSpecies[];
  totalDetections: number;
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

export function SpeciesCards({ species, totalDetections }: SpeciesCardsProps) {
  if (species.length === 0) {
    return (
      <div className="flex items-center justify-center h-[200px] bg-muted rounded-xl">
        <p className="text-muted-foreground">
          No se han verificado identificaciones de especies para este sitio.
        </p>
      </div>
    );
  }

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
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {species.map((sp) => (
          <Card key={sp.speciesName} className="overflow-hidden">
            {/* Photo */}
            <div className="relative h-40 bg-muted">
              {sp.photoImageId ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={`/api/ct-images/${sp.photoImageId}?size=thumb`}
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
        ))}
      </div>
    </div>
  );
}
