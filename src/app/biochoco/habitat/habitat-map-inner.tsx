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
import type { SiteInfo } from "../overview/types";
import { getHabitatName } from "../overview/types";
import { useReserveBoundary } from "@/lib/use-reserve-boundary";
import { HABITAT_COLORS } from "./types";

interface HabitatMapInnerProps {
  validSites: SiteInfo[];
  assessedSet: Set<string>;
}

export default function HabitatMapInner({
  validSites,
  assessedSet,
}: HabitatMapInnerProps) {
  const boundary = useReserveBoundary();

  const center = useMemo(() => {
    const lats = validSites.map((s) => s.lat!);
    const lngs = validSites.map((s) => s.lng!);
    return {
      lat: lats.reduce((a, b) => a + b, 0) / lats.length,
      lng: lngs.reduce((a, b) => a + b, 0) / lngs.length,
    };
  }, [validSites]);

  // Build legend entries from habitat types present
  const legendEntries = useMemo(() => {
    const types = new Set(validSites.map((s) => s.habitatType).filter(Boolean));
    return [...types].map((t) => ({
      type: t,
      name: getHabitatName(t),
      color: HABITAT_COLORS[t] ?? "#9E9E9E",
    }));
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
          const assessed = assessedSet.has(site.siteId);
          const color = assessed
            ? (HABITAT_COLORS[site.habitatType] ?? "#9E9E9E")
            : "#9E9E9E";

          return (
            <CircleMarker
              key={site.siteId}
              center={[site.lat!, site.lng!]}
              radius={assessed ? 8 : 6}
              pathOptions={{
                color,
                fillColor: color,
                fillOpacity: assessed ? 0.85 : 0.3,
              }}
            >
              <Popup>
                <div className="text-xs space-y-0.5 min-w-[180px]">
                  <p className="font-bold" style={{ color }}>
                    {site.siteName}
                  </p>
                  <p>
                    <strong>ID:</strong> {site.siteId}
                  </p>
                  <p>
                    <strong>Hábitat:</strong> {getHabitatName(site.habitatType)}
                  </p>
                  <p>
                    <strong>Evaluado:</strong> {assessed ? "Sí" : "No"}
                  </p>
                  <p>
                    <strong>Coords:</strong> {site.lat?.toFixed(5)},{" "}
                    {site.lng?.toFixed(5)}
                  </p>
                </div>
              </Popup>
            </CircleMarker>
          );
        })}
      </MapContainer>

      <div className="flex items-center gap-4 px-4 py-2 bg-card text-xs border-t flex-wrap">
        <span className="font-medium">Leyenda:</span>
        {legendEntries.map((e) => (
          <span key={e.type} className="flex items-center gap-1">
            <span
              className="inline-block w-3 h-3 rounded-full"
              style={{ backgroundColor: e.color }}
            />
            {e.name}
          </span>
        ))}
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full bg-gray-400 opacity-40" />
          Sin evaluar
        </span>
      </div>
    </div>
  );
}
