"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import type { SiteWithReadiness } from "./types";

const MapInner = dynamic(() => import("./resultados-map-inner"), { ssr: false });

interface ResultadosMapProps {
  sites: SiteWithReadiness[];
}

export function ResultadosMap({ sites }: ResultadosMapProps) {
  const validSites = useMemo(
    () => sites.filter((s) => s.lat !== null && s.lng !== null),
    [sites]
  );

  if (validSites.length === 0) {
    return (
      <div className="flex items-center justify-center h-[400px] bg-muted rounded-xl">
        <p className="text-muted-foreground">No hay sitios con coordenadas disponibles</p>
      </div>
    );
  }

  return <MapInner validSites={validSites} />;
}
