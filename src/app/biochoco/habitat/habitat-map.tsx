"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import type { SiteInfo } from "../overview/types";

const MapInner = dynamic(() => import("./habitat-map-inner"), { ssr: false });

interface HabitatMapProps {
  sites: SiteInfo[];
  assessedSet: Set<string>;
}

export function HabitatMap({ sites, assessedSet }: HabitatMapProps) {
  const validSites = useMemo(
    () => sites.filter((s) => s.lat !== null && s.lng !== null),
    [sites]
  );

  if (validSites.length === 0) {
    return (
      <div className="flex items-center justify-center h-[400px] bg-muted rounded-xl">
        <p className="text-muted-foreground">No hay coordenadas disponibles</p>
      </div>
    );
  }

  return <MapInner validSites={validSites} assessedSet={assessedSet} />;
}
