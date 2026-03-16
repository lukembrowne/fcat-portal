"use client";

import { useMemo } from "react";
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Popup,
  LayersControl,
  GeoJSON,
} from "react-leaflet";
import type { TreeRecord } from "@/lib/odk-types";
import { useReserveBoundary } from "@/lib/use-reserve-boundary";

export type ColorByMode = "condicion" | "species";

const SPECIES_COLORS = [
  "#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231",
  "#911eb4", "#42d4f4", "#f032e6", "#bfef45", "#fabed4",
  "#469990", "#dcbeff", "#9A6324", "#800000", "#aaffc3",
];

function getCondicionColor(tree: TreeRecord): string {
  if (tree.survival === "muerto") return "#ef4444";
  switch (tree.condition) {
    case "excelente":
      return "#22c55e";
    case "regular":
      return "#f97316";
    case "mala":
      return "#ef4444";
    default:
      return "#3b82f6";
  }
}

function buildSpeciesColorMap(trees: TreeRecord[]): Map<string, string> {
  const species = [...new Set(trees.map((t) => t.species).filter(Boolean))].sort();
  const map = new Map<string, string>();
  species.forEach((s, i) => {
    map.set(s, SPECIES_COLORS[i % SPECIES_COLORS.length]);
  });
  return map;
}

interface TreeMapInnerProps {
  trees: TreeRecord[];
  colorBy: ColorByMode;
  onColorByChange: (mode: ColorByMode) => void;
}

export default function TreeMapInner({ trees, colorBy, onColorByChange }: TreeMapInnerProps) {
  const boundary = useReserveBoundary();

  const center = useMemo(() => {
    const lats = trees.map((t) => t.lat!);
    const lngs = trees.map((t) => t.lng!);
    return {
      lat: lats.reduce((a, b) => a + b, 0) / lats.length,
      lng: lngs.reduce((a, b) => a + b, 0) / lngs.length,
    };
  }, [trees]);

  const speciesColorMap = useMemo(() => buildSpeciesColorMap(trees), [trees]);

  function getColor(tree: TreeRecord): string {
    if (colorBy === "species") {
      return tree.species ? (speciesColorMap.get(tree.species) ?? "#3b82f6") : "#3b82f6";
    }
    return getCondicionColor(tree);
  }

  return (
    <div className="rounded-xl overflow-hidden border">
      <div className="flex items-center gap-2 px-4 py-2 bg-card border-b">
        <span className="text-xs font-medium text-muted-foreground">Color por:</span>
        <button
          onClick={() => onColorByChange("condicion")}
          className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
            colorBy === "condicion"
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:bg-muted/80"
          }`}
        >
          Condición
        </button>
        <button
          onClick={() => onColorByChange("species")}
          className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
            colorBy === "species"
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:bg-muted/80"
          }`}
        >
          Especie
        </button>
      </div>

      <MapContainer
        center={[center.lat, center.lng]}
        zoom={12}
        style={{ height: "450px", width: "100%" }}
      >
        <LayersControl position="topright">
          <LayersControl.BaseLayer name="Calles">
            <TileLayer
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
            />
          </LayersControl.BaseLayer>
          <LayersControl.BaseLayer checked name="Satélite">
            <TileLayer
              url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
              attribution="&copy; Esri"
            />
          </LayersControl.BaseLayer>
          {boundary && (
            <LayersControl.Overlay checked name="Reserva FCAT">
              <GeoJSON
                data={boundary}
                interactive={false}
                style={{
                  color: "#22c55e",
                  weight: 2,
                  dashArray: "6 4",
                  fillColor: "#22c55e",
                  fillOpacity: 0.08,
                }}
              />
            </LayersControl.Overlay>
          )}
        </LayersControl>

        {trees.map((tree) => {
          const color = getColor(tree);
          return (
            <CircleMarker
              key={tree.id}
              center={[tree.lat!, tree.lng!]}
              radius={8}
              pathOptions={{
                color,
                fillColor: color,
                fillOpacity: 0.7,
              }}
            >
              <Popup>
                <div className="text-xs space-y-0.5">
                  <p>
                    <strong>Especie:</strong> {tree.species || "N/A"}
                  </p>
                  <p>
                    <strong>Finca:</strong> {tree.farm || "N/A"}
                  </p>
                  <p>
                    <strong>Dueño:</strong> {tree.owner || "N/A"}
                  </p>
                  <p>
                    <strong>Altura:</strong> {tree.height ?? "N/A"} cm
                  </p>
                  <p>
                    <strong>Condición:</strong> {tree.condition || "N/A"}
                  </p>
                  <p>
                    <strong>Estado:</strong> {tree.survival || "N/A"}
                  </p>
                  <p>
                    <strong>Fecha:</strong> {tree.date ?? "N/A"}
                  </p>
                </div>
              </Popup>
            </CircleMarker>
          );
        })}
      </MapContainer>

      <div className="flex items-center gap-4 px-4 py-2 bg-card text-xs border-t flex-wrap">
        {colorBy === "condicion" ? (
          <>
            <span className="font-medium">Condición:</span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-full bg-green-500" />
              Excelente
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-full bg-orange-500" />
              Regular
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-full bg-red-500" />
              Mala/Muerto
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-full bg-blue-500" />
              Sin datos
            </span>
          </>
        ) : (
          <>
            <span className="font-medium">Especie:</span>
            {[...speciesColorMap.entries()].map(([species, color]) => (
              <span key={species} className="flex items-center gap-1">
                <span
                  className="inline-block w-3 h-3 rounded-full"
                  style={{ backgroundColor: color }}
                />
                {species}
              </span>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
