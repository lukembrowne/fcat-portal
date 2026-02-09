"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import type { CacaoRecord } from "@/lib/odk-types";

const MapInner = dynamic(() => import("./cacao-map-inner"), { ssr: false });

export function CacaoMap({ records }: { records: CacaoRecord[] }) {
  const mapRecords = useMemo(
    () => records.filter((r) => r.lat !== null && r.lng !== null),
    [records]
  );

  if (mapRecords.length === 0) {
    return (
      <div className="flex items-center justify-center h-[400px] bg-muted rounded-xl">
        <p className="text-muted-foreground">No hay coordenadas GPS disponibles</p>
      </div>
    );
  }

  return <MapInner records={mapRecords} />;
}
