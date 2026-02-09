"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import type { ScheduleRow } from "@/lib/schedule-types";
import type { SiteInfo } from "./types";

const MapInner = dynamic(() => import("./overview-map-inner"), { ssr: false });

interface OverviewMapProps {
  sites: SiteInfo[];
  deploymentsThisMonth: ScheduleRow[];
  retrievalsThisMonth: ScheduleRow[];
  deployedSet: Set<string>;
  retrievedSet: Set<string>;
}

export function OverviewMap(props: OverviewMapProps) {
  const validSites = useMemo(
    () => props.sites.filter((s) => s.lat !== null && s.lng !== null),
    [props.sites]
  );

  if (validSites.length === 0) {
    return (
      <div className="flex items-center justify-center h-[400px] bg-muted rounded-xl">
        <p className="text-muted-foreground">No hay coordenadas disponibles</p>
      </div>
    );
  }

  return <MapInner {...props} validSites={validSites} />;
}
