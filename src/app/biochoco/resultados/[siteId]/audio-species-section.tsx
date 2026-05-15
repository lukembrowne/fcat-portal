"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { SiteAudioSpecies } from "../types";

const INITIAL_LIMIT = 12;

export function AudioSpeciesSection({
  species,
}: {
  species: SiteAudioSpecies[];
}) {
  const [showAll, setShowAll] = useState(false);

  if (species.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No hay anotaciones BirdNET verificadas para este sitio aún.
      </p>
    );
  }

  const visible = showAll ? species : species.slice(0, INITIAL_LIMIT);
  const totalDetections = species.reduce((sum, s) => sum + s.detectionCount, 0);

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {species.length} {species.length === 1 ? "especie" : "especies"}{" "}
        verificada
        {species.length === 1 ? "" : "s"} ·{" "}
        {totalDetections.toLocaleString("es-ES")} detecciones BirdNET.
      </p>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((s) => (
          <li
            key={s.speciesName}
            className="rounded-md border bg-card px-3 py-2"
          >
            <div className="flex items-baseline justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm italic">{s.speciesName}</p>
                {s.spanishName && (
                  <p className="truncate text-xs text-muted-foreground">
                    {s.spanishName}
                  </p>
                )}
              </div>
              <div className="shrink-0 text-right text-xs tabular-nums">
                <p className="font-semibold">
                  {s.detectionCount.toLocaleString("es-ES")}
                </p>
                <p className="text-muted-foreground">
                  conf {s.avgConfidence.toFixed(2)}
                </p>
              </div>
            </div>
          </li>
        ))}
      </ul>
      {species.length > INITIAL_LIMIT && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll
            ? "Mostrar menos"
            : `Mostrar ${species.length - INITIAL_LIMIT} más`}
        </Button>
      )}
    </div>
  );
}
