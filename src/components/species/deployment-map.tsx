"use client";

import dynamic from "next/dynamic";
import type { SpeciesMapMarker } from "./deployment-map-inner";

const DeploymentMapInner = dynamic(() => import("./deployment-map-inner"), {
  ssr: false,
  loading: () => <MapPlaceholder />,
});

function MapPlaceholder() {
  return (
    <div className="rounded-lg border bg-muted/30 h-[420px] flex items-center justify-center text-sm text-muted-foreground">
      Cargando mapa...
    </div>
  );
}

interface Props {
  markers: SpeciesMapMarker[];
}

export function DeploymentMap(props: Props) {
  return <DeploymentMapInner {...props} />;
}
