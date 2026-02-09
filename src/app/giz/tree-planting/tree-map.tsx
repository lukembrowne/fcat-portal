"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import type { TreeRecord } from "@/lib/odk-types";
import type { ColorByMode } from "./tree-map-inner";

const MapInner = dynamic(() => import("./tree-map-inner"), { ssr: false });

interface TreeMapProps {
  trees: TreeRecord[];
  colorBy: ColorByMode;
  onColorByChange: (mode: ColorByMode) => void;
}

export function TreeMap({ trees, colorBy, onColorByChange }: TreeMapProps) {
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

  return <MapInner trees={mapTrees} colorBy={colorBy} onColorByChange={onColorByChange} />;
}
