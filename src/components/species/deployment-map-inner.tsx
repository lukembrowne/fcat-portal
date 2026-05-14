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
import "leaflet/dist/leaflet.css";
import { useReserveBoundary } from "@/lib/use-reserve-boundary";

export interface SpeciesMapMarker {
  deploymentId: number;
  deploymentName: string;
  latitude: number;
  longitude: number;
  detectionCount: number;
  /** Anchor link rendered in the popup. Pre-computed server-side so the
   *  component receives plain data (no function props across the
   *  Server→Client boundary). */
  href: string;
}

interface Props {
  markers: SpeciesMapMarker[];
}

export default function DeploymentMapInner({ markers }: Props) {
  const boundary = useReserveBoundary();

  const { center, maxCount } = useMemo(() => {
    if (markers.length === 0) {
      return { center: { lat: 0.4, lng: -79.1 }, maxCount: 1 };
    }
    const sumLat = markers.reduce((a, m) => a + m.latitude, 0);
    const sumLng = markers.reduce((a, m) => a + m.longitude, 0);
    return {
      center: { lat: sumLat / markers.length, lng: sumLng / markers.length },
      maxCount: markers.reduce((a, m) => Math.max(a, m.detectionCount), 1),
    };
  }, [markers]);

  return (
    <div className="rounded-lg overflow-hidden border">
      <MapContainer
        center={[center.lat, center.lng]}
        zoom={13}
        style={{ height: "420px", width: "100%" }}
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

        {markers.map((m) => {
          const ratio = Math.sqrt(m.detectionCount / maxCount);
          const radius = 6 + ratio * 18; // 6..24px
          return (
            <CircleMarker
              key={m.deploymentId}
              center={[m.latitude, m.longitude]}
              radius={radius}
              pathOptions={{
                color: "#0ea5e9",
                fillColor: "#0ea5e9",
                fillOpacity: 0.55,
                weight: 1,
              }}
            >
              <Popup>
                <div className="text-xs space-y-1 min-w-[180px]">
                  <p className="font-bold text-sky-700">{m.deploymentName}</p>
                  <p>
                    <strong>Detecciones:</strong>{" "}
                    {m.detectionCount.toLocaleString("es-EC")}
                  </p>
                  <a href={m.href} className="text-sky-700 underline">
                    Ver detecciones →
                  </a>
                </div>
              </Popup>
            </CircleMarker>
          );
        })}
      </MapContainer>
    </div>
  );
}
