"use client";

import { useMemo } from "react";
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Popup,
  LayersControl,
} from "react-leaflet";
import type { TreeRecord } from "@/lib/odk-types";

function getMarkerColor(tree: TreeRecord): string {
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

export default function TreeMapInner({ trees }: { trees: TreeRecord[] }) {
  const center = useMemo(() => {
    const lats = trees.map((t) => t.lat!);
    const lngs = trees.map((t) => t.lng!);
    return {
      lat: lats.reduce((a, b) => a + b, 0) / lats.length,
      lng: lngs.reduce((a, b) => a + b, 0) / lngs.length,
    };
  }, [trees]);

  return (
    <div className="rounded-xl overflow-hidden border">
      <MapContainer
        center={[center.lat, center.lng]}
        zoom={12}
        style={{ height: "450px", width: "100%" }}
      >
        <LayersControl position="topright">
          <LayersControl.BaseLayer checked name="Calles">
            <TileLayer
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
            />
          </LayersControl.BaseLayer>
          <LayersControl.BaseLayer name="Satélite">
            <TileLayer
              url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
              attribution="&copy; Esri"
            />
          </LayersControl.BaseLayer>
        </LayersControl>

        {trees.map((tree) => (
          <CircleMarker
            key={tree.id}
            center={[tree.lat!, tree.lng!]}
            radius={8}
            pathOptions={{
              color: getMarkerColor(tree),
              fillColor: getMarkerColor(tree),
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
        ))}
      </MapContainer>

      <div className="flex items-center gap-4 px-4 py-2 bg-card text-xs border-t">
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
      </div>
    </div>
  );
}
