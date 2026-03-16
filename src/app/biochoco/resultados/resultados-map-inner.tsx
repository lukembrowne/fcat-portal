"use client";

import { useMemo } from "react";
import Link from "next/link";
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Popup,
  LayersControl,
  GeoJSON,
} from "react-leaflet";
import { useReserveBoundary } from "@/lib/use-reserve-boundary";
import { getHabitatName } from "../overview/types";
import { HABITAT_COLORS } from "../habitat/types";
import type { SiteWithReadiness, ReadinessStatus } from "./types";
import { CheckCircle2, Clock, Minus } from "lucide-react";

interface ResultadosMapInnerProps {
  validSites: SiteWithReadiness[];
}

function ReadinessIcon({ status }: { status: ReadinessStatus }) {
  if (status === "complete")
    return <CheckCircle2 className="h-3 w-3 text-green-600 inline" />;
  if (status === "in_progress")
    return <Clock className="h-3 w-3 text-amber-500 inline" />;
  return <Minus className="h-3 w-3 text-gray-400 inline" />;
}

export default function ResultadosMapInner({
  validSites,
}: ResultadosMapInnerProps) {
  const boundary = useReserveBoundary();

  const center = useMemo(() => {
    const lats = validSites.map((s) => s.lat!);
    const lngs = validSites.map((s) => s.lng!);
    return {
      lat: lats.reduce((a, b) => a + b, 0) / lats.length,
      lng: lngs.reduce((a, b) => a + b, 0) / lngs.length,
    };
  }, [validSites]);

  return (
    <div className="rounded-xl overflow-hidden border">
      <MapContainer
        center={[center.lat, center.lng]}
        zoom={13}
        style={{ height: "500px", width: "100%" }}
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

        {validSites.map((site) => {
          const color = HABITAT_COLORS[site.habitatType] ?? "#6B7280";

          return (
            <CircleMarker
              key={site.siteId}
              center={[site.lat!, site.lng!]}
              radius={8}
              pathOptions={{
                color,
                fillColor: color,
                fillOpacity: 0.7,
              }}
            >
              <Popup>
                <div className="text-xs space-y-1 min-w-[200px]">
                  <p className="font-bold text-sm">{site.siteName}</p>
                  <p>
                    <strong>ID:</strong> {site.siteId}
                  </p>
                  <p>
                    <strong>Hábitat:</strong> {getHabitatName(site.habitatType)}
                  </p>
                  <p>
                    <strong>Visitas:</strong> {site.deploymentCount}
                  </p>
                  <div className="flex items-center gap-3 pt-1">
                    <span className="flex items-center gap-1">
                      <ReadinessIcon status={site.readiness.cameras} /> Cámaras
                    </span>
                    <span className="flex items-center gap-1">
                      <ReadinessIcon status={site.readiness.temperature} /> Temp
                    </span>
                    <span className="flex items-center gap-1">
                      <ReadinessIcon status={site.readiness.habitat} /> Háb
                    </span>
                  </div>
                  <Link
                    href={`/biochoco/resultados/${site.siteId}`}
                    className="text-blue-600 hover:underline block pt-1 font-medium"
                  >
                    Ver resultados →
                  </Link>
                </div>
              </Popup>
            </CircleMarker>
          );
        })}
      </MapContainer>

      <div className="flex items-center gap-4 px-4 py-2 bg-card text-xs border-t flex-wrap">
        <span className="font-medium">Hábitats:</span>
        {Object.entries(HABITAT_COLORS).map(([key, color]) => (
          <span key={key} className="flex items-center gap-1">
            <span
              className="inline-block w-3 h-3 rounded-full"
              style={{ backgroundColor: color }}
            />
            {getHabitatName(key)}
          </span>
        ))}
      </div>
    </div>
  );
}
