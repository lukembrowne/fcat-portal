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
import type { CacaoRecord } from "@/lib/odk-types";
import { useReserveBoundary } from "@/lib/use-reserve-boundary";

function getMarkerColor(survivalRate: number | null): string {
  if (survivalRate == null) return "#3b82f6";
  if (survivalRate >= 80) return "#22c55e";
  if (survivalRate >= 50) return "#f97316";
  return "#ef4444";
}

export default function CacaoMapInner({ records }: { records: CacaoRecord[] }) {
  const boundary = useReserveBoundary();

  const center = useMemo(() => {
    const lats = records.map((r) => r.lat!);
    const lngs = records.map((r) => r.lng!);
    return {
      lat: lats.reduce((a, b) => a + b, 0) / lats.length,
      lng: lngs.reduce((a, b) => a + b, 0) / lngs.length,
    };
  }, [records]);

  return (
    <div className="rounded-xl overflow-hidden border">
      <MapContainer
        center={[center.lat, center.lng]}
        zoom={10}
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

        {records.map((record) => {
          const color = getMarkerColor(record.survivalRate);
          return (
            <CircleMarker
              key={record.id}
              center={[record.lat!, record.lng!]}
              radius={10}
              pathOptions={{
                color,
                fillColor: color,
                fillOpacity: 0.7,
              }}
            >
              <Popup>
                <div className="text-xs space-y-0.5">
                  <p><strong>Finca:</strong> {record.farmCode || "N/A"}</p>
                  <p><strong>Propietario:</strong> {record.ownerName || "N/A"}</p>
                  <p><strong>Comunidad:</strong> {record.community || "N/A"}</p>
                  <p><strong>Plantas:</strong> {record.plantsPlanted ?? "N/A"}</p>
                  <p><strong>Vivas:</strong> {record.plantsAlive ?? "N/A"}</p>
                  <p><strong>Supervivencia:</strong> {record.survivalRate != null ? `${record.survivalRate.toFixed(1)}%` : "N/A"}</p>
                  <p><strong>Días desde siembra:</strong> {record.daysSincePlanting ?? "N/A"}</p>
                </div>
              </Popup>
            </CircleMarker>
          );
        })}
      </MapContainer>

      <div className="flex items-center gap-4 px-4 py-2 bg-card text-xs border-t">
        <span className="font-medium">Supervivencia:</span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full bg-green-500" />
          ≥80%
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full bg-orange-500" />
          50-79%
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full bg-red-500" />
          &lt;50%
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full bg-blue-500" />
          Sin datos
        </span>
      </div>
    </div>
  );
}
