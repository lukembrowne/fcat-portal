"use client";

import { useMemo } from "react";
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Marker,
  Popup,
  LayersControl,
  GeoJSON,
} from "react-leaflet";
import L from "leaflet";
import type { ScheduleRow } from "@/lib/schedule-types";
import type { SiteInfo } from "./types";
import { useReserveBoundary } from "@/lib/use-reserve-boundary";
import { getHabitatName } from "./types";

const CAMERA_ICON = L.divIcon({
  html: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>`,
  className: "",
  iconSize: [20, 20],
  iconAnchor: [10, 24],
});

interface OverviewMapInnerProps {
  validSites: SiteInfo[];
  deploymentsThisMonth: ScheduleRow[];
  retrievalsThisMonth: ScheduleRow[];
  deployedSet: Set<string>;
  retrievedSet: Set<string>;
}

export default function OverviewMapInner({
  validSites,
  deploymentsThisMonth,
  retrievalsThisMonth,
  deployedSet,
  retrievedSet,
}: OverviewMapInnerProps) {
  const boundary = useReserveBoundary();

  const deployingSiteIds = useMemo(
    () => new Set(deploymentsThisMonth.map((r) => r.siteId)),
    [deploymentsThisMonth]
  );
  const retrievingSiteIds = useMemo(
    () => new Set(retrievalsThisMonth.map((r) => r.siteId)),
    [retrievalsThisMonth]
  );

  // Sites with sensors currently deployed (deployed but not retrieved)
  const currentlyDeployedSiteIds = useMemo(() => {
    const s = new Set<string>();
    for (const depId of deployedSet) {
      if (!retrievedSet.has(depId)) {
        const siteId = depId.includes("_") ? depId.split("_").slice(0, -1).join("_") : depId;
        s.add(siteId);
      }
    }
    return s;
  }, [deployedSet, retrievedSet]);

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
          const isDeploy = deployingSiteIds.has(site.siteId);
          const isRetrieve = retrievingSiteIds.has(site.siteId);
          const hasSensor = currentlyDeployedSiteIds.has(site.siteId);

          let color = "#9E9E9E";
          let radius = 6;
          let opacity = 0.4;
          let action = "Sin actividad este mes";

          if (isDeploy) {
            color = "#4CAF50";
            action = "Instalar";
            radius = 10;
            opacity = 0.9;
          } else if (isRetrieve) {
            color = "#FF9800";
            action = "Recuperar";
            radius = 10;
            opacity = 0.9;
          }

          return (
            <CircleMarker
              key={site.siteId}
              center={[site.lat!, site.lng!]}
              radius={radius}
              pathOptions={{
                color,
                fillColor: color,
                fillOpacity: opacity,
              }}
            >
              <Popup>
                <div className="text-xs space-y-0.5 min-w-[180px]">
                  <p className="font-bold" style={{ color }}>{site.siteName}</p>
                  <p><strong>ID:</strong> {site.siteId}</p>
                  <p><strong>Acción:</strong> {action}</p>
                  <p><strong>Sensor:</strong> {hasSensor ? "Instalado" : "No"}</p>
                  <p><strong>Hábitat:</strong> {getHabitatName(site.habitatType)}</p>
                  <p><strong>Coords:</strong> {site.lat?.toFixed(5)}, {site.lng?.toFixed(5)}</p>
                </div>
              </Popup>
            </CircleMarker>
          );
        })}

        {validSites
          .filter((site) => currentlyDeployedSiteIds.has(site.siteId))
          .map((site) => (
            <Marker
              key={`camera-${site.siteId}`}
              position={[site.lat!, site.lng!]}
              icon={CAMERA_ICON}
              interactive={false}
            />
          ))}
      </MapContainer>

      <div className="flex items-center gap-4 px-4 py-2 bg-card text-xs border-t flex-wrap">
        <span className="font-medium">Leyenda:</span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full bg-green-500" />
          Instalar
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full bg-orange-500" />
          Recuperar
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full bg-gray-400" />
          Sin actividad
        </span>
        <span className="flex items-center gap-1">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>
          Sensor instalado
        </span>
      </div>
    </div>
  );
}
