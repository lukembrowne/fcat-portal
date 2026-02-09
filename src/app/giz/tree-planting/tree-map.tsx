"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import type { TreeRecord } from "@/lib/odk-types";

const MapInner = dynamic(() => import("./tree-map-inner"), { ssr: false });

export function TreeMap({ trees }: { trees: TreeRecord[] }) {
  const mapTrees = useMemo(
    () => trees.filter((t) => t.lat !== null && t.lng !== null),
    [trees]
  );

  if (mapTrees.length === 0) {
    return (
      <div className="flex items-center justify-center h-[400px] bg-muted rounded-xl">
        <p className="text-muted-foreground">No hay coordenadas GPS disponibles</p>
      </div>
    );
  }

  return <MapInner trees={mapTrees} />;
}
