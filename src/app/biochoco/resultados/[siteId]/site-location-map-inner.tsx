"use client";

import {
  MapContainer,
  TileLayer,
  CircleMarker,
  LayersControl,
  GeoJSON,
} from "react-leaflet";
import { useReserveBoundary } from "@/lib/use-reserve-boundary";

interface SiteLocationMapInnerProps {
  lat: number;
  lng: number;
}

export default function SiteLocationMapInner({
  lat,
  lng,
}: SiteLocationMapInnerProps) {
  const boundary = useReserveBoundary();

  return (
    <div className="rounded-xl overflow-hidden border">
      <MapContainer
        center={[lat, lng]}
        zoom={14}
        style={{ height: "200px", width: "100%" }}
        scrollWheelZoom={false}
        dragging={false}
        zoomControl={false}
        doubleClickZoom={false}
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

        <CircleMarker
          center={[lat, lng]}
          radius={10}
          pathOptions={{
            color: "#ef4444",
            fillColor: "#ef4444",
            fillOpacity: 0.8,
          }}
        />
      </MapContainer>
    </div>
  );
}
