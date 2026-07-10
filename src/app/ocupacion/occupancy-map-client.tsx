"use client";

import dynamic from "next/dynamic";
import type { OccupancyMapProps } from "./occupancy-map";

const OccupancyMapInner = dynamic(() => import("./occupancy-map"), {
  ssr: false,
  loading: () => (
    <div className="h-[440px] w-full rounded-lg border bg-muted/30 flex items-center justify-center text-sm text-muted-foreground">
      Cargando mapa…
    </div>
  ),
});

export function OccupancyMapClient(props: OccupancyMapProps) {
  return <OccupancyMapInner {...props} />;
}
