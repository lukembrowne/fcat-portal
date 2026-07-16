"use client";

import { useState } from "react";
import {
  MapContainer,
  TileLayer,
  ImageOverlay,
  LayersControl,
  LayerGroup,
  CircleMarker,
  Popup,
  GeoJSON,
  useMapEvents,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { useReserveBoundary } from "@/lib/use-reserve-boundary";

export interface MapCell {
  lat: number;
  lng: number;
  psi: number | null;
  lower: number | null;
  upper: number | null;
  forest: number | null;
  elevation: number | null;
}

export interface MapSite {
  lat: number;
  lng: number;
  /** Deployment id — enables the marker popup + the "Ver despliegue" link. */
  siteId?: string;
  siteName?: string | null;
  habitat?: string | null;
  /** Meters. */
  elevation?: number | null;
  /** 0..1 forest-cover fraction within the sampling buffer. */
  forestCover?: number | null;
  /** Whether the species was detected here. null = unknown (e.g. richness map). */
  detected?: boolean | null;
  detections?: number | null;
}

/** Legend/hover mode: per-species occupancy (ψ) or cross-species richness (Σψ). */
export type MapLegend = { kind: "psi" } | { kind: "richness"; max: number };

export interface OccupancyMapProps {
  runId: number;
  /** Surface basename for the per-species ψ PNG (null if none rendered). */
  psiName: string | null;
  hasForest: boolean;
  hasElevation: boolean;
  /** [minLng, minLat, maxLng, maxLat] cell-edge extent. */
  bbox: number[] | null;
  cells: MapCell[];
  /** Deployment locations used in this species' model (sampling points). */
  sites?: MapSite[];
  /** What the color ramp encodes — drives the legend + hover readout. */
  legend?: MapLegend;
}

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

// Detected sites read as solid emerald with a white ring (legible over the
// viridis ψ surface); not-detected are hollow slate; unknown (richness map or
// no matching detection row) keeps the neutral white dot.
function markerStyle(detected?: boolean | null) {
  if (detected === true)
    return { color: "#ffffff", weight: 1.5, fillColor: "#059669", fillOpacity: 0.95 };
  if (detected === false)
    return { color: "#0f172a", weight: 1, fillColor: "#ffffff", fillOpacity: 0.75 };
  return { color: "#0f172a", weight: 1, fillColor: "#ffffff", fillOpacity: 0.9 };
}
const markerRadius = (detected?: boolean | null) =>
  detected === true ? 5 : detected === false ? 4 : 3;

/** Click popup for a sampling site: detection status + the ψ covariates. */
function SitePopup({ site }: { site: MapSite }) {
  return (
    <div className="text-[12px] leading-snug">
      <div className="font-semibold">{site.siteName || `Sitio ${site.siteId}`}</div>
      <div className="mt-0.5">
        {site.detected == null ? (
          <span className="text-gray-500">Detección sin dato</span>
        ) : site.detected ? (
          <span className="font-medium text-emerald-700">
            Detectada
            {site.detections != null ? ` · ${site.detections} detección(es)` : ""}
          </span>
        ) : (
          <span className="text-gray-500">No detectada</span>
        )}
      </div>
      <dl className="mt-1 space-y-0.5 text-gray-600">
        <div>Hábitat: {site.habitat || "—"}</div>
        <div>Elevación: {site.elevation != null ? `${site.elevation.toFixed(0)} m` : "—"}</div>
        <div>Bosque: {site.forestCover != null ? pct(site.forestCover) : "—"}</div>
      </dl>
      {site.siteId != null ? (
        <a
          href={`/camera-trap/${site.siteId}`}
          className="mt-1 inline-block font-medium text-sky-700 hover:underline"
        >
          Ver despliegue →
        </a>
      ) : null}
    </div>
  );
}

/** Nearest-cell probe: on mousemove report the closest grid cell for the readout. */
function HoverProbe({ cells, onHover }: { cells: MapCell[]; onHover: (c: MapCell | null) => void }) {
  useMapEvents({
    mousemove(e) {
      const { lat, lng } = e.latlng;
      let best: MapCell | null = null;
      let bd = Infinity;
      for (const c of cells) {
        const d = (c.lat - lat) ** 2 + (c.lng - lng) ** 2;
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      onHover(best);
    },
    mouseout() {
      onHover(null);
    },
  });
  return null;
}

/** Padded lat/lng bounds around the sampling points, for the initial camera. */
function siteViewBounds(sites: MapSite[]): [[number, number], [number, number]] | null {
  if (sites.length === 0) return null;
  const lats = sites.map((s) => s.lat);
  const lngs = sites.map((s) => s.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  // ~10% padding (with a floor so a single/clustered site still frames sensibly).
  const padLat = Math.max((maxLat - minLat) * 0.1, 0.002);
  const padLng = Math.max((maxLng - minLng) * 0.1, 0.002);
  return [
    [minLat - padLat, minLng - padLng],
    [maxLat + padLat, maxLng + padLng],
  ];
}

/**
 * Predicted-occupancy surface over the AOI, rendered as colorized raster
 * ImageOverlays (ψ, plus toggleable forest-cover and elevation covariate layers),
 * with the FCAT reserve outline and the sampling points overlaid. Hover reads the
 * nearest grid cell. The layer switcher is pinned open (collapsed=false). The
 * initial camera frames the sampling sites when present, else the whole AOI.
 */
export function OccupancyMap({
  runId,
  psiName,
  hasForest,
  hasElevation,
  bbox,
  cells,
  sites,
  legend = { kind: "psi" },
}: OccupancyMapProps) {
  const [hover, setHover] = useState<MapCell | null>(null);
  const withPsi = cells.filter((c) => c.psi != null);
  const boundary = useReserveBoundary();

  const b =
    bbox && bbox.length === 4
      ? bbox
      : cells.length
        ? [
            Math.min(...cells.map((c) => c.lng)),
            Math.min(...cells.map((c) => c.lat)),
            Math.max(...cells.map((c) => c.lng)),
            Math.max(...cells.map((c) => c.lat)),
          ]
        : null;

  if (!b || (!psiName && !hasForest && !hasElevation)) {
    return (
      <div className="rounded-lg border p-6 text-sm text-muted-foreground">
        Superficie de ocurrencia predicha no disponible (requiere las capas ráster de cobertura
        boscosa y elevación del área de estudio).
      </div>
    );
  }

  // AOI overlay bounds: [[south, west], [north, east]]. Overlays always cover the
  // full prediction extent; only the initial camera zooms to the sampling sites.
  const aoiBounds: [[number, number], [number, number]] = [
    [b[1], b[0]],
    [b[3], b[2]],
  ];
  const viewBounds = (sites && siteViewBounds(sites)) || aoiBounds;
  const isRichness = legend.kind === "richness";
  // Only show the detected/no-detected key when the markers actually carry
  // detection status (per-species map), not on the cross-species richness map.
  const hasDetectionData = !!sites?.some((s) => s.detected != null);
  const url = (name: string) => `/api/ocupacion/surface/${runId}/${name}`;

  return (
    <div className="relative h-[440px] w-full overflow-hidden rounded-lg border">
      <MapContainer bounds={viewBounds} style={{ height: "100%", width: "100%" }} scrollWheelZoom>
        <LayersControl position="topright" collapsed={false}>
          <LayersControl.BaseLayer checked name="Mapa">
            <TileLayer
              attribution="&copy; OpenStreetMap"
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
          </LayersControl.BaseLayer>
          <LayersControl.BaseLayer name="Satélite">
            <TileLayer
              attribution="&copy; Esri"
              url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            />
          </LayersControl.BaseLayer>
          {psiName ? (
            <LayersControl.Overlay checked name={isRichness ? "Riqueza (Σψ)" : "Ocupación (ψ)"}>
              <ImageOverlay url={url(psiName)} bounds={aoiBounds} opacity={0.85} />
            </LayersControl.Overlay>
          ) : null}
          {hasForest ? (
            <LayersControl.Overlay name="Cobertura boscosa">
              <ImageOverlay url={url("_forest")} bounds={aoiBounds} opacity={0.85} />
            </LayersControl.Overlay>
          ) : null}
          {hasElevation ? (
            <LayersControl.Overlay name="Elevación">
              <ImageOverlay url={url("_elevation")} bounds={aoiBounds} opacity={0.85} />
            </LayersControl.Overlay>
          ) : null}
          {boundary ? (
            <LayersControl.Overlay checked name="Reserva FCAT">
              <GeoJSON
                data={boundary}
                interactive={false}
                style={{ color: "#16a34a", weight: 2.5, fill: false, dashArray: "5 4" }}
              />
            </LayersControl.Overlay>
          ) : null}
          {sites && sites.length > 0 ? (
            <LayersControl.Overlay checked name={`Sitios de muestreo (${sites.length})`}>
              <LayerGroup>
                {sites.map((s, i) => (
                  <CircleMarker key={i} center={[s.lat, s.lng]} pathOptions={markerStyle(s.detected)} radius={markerRadius(s.detected)}>
                    {s.siteId != null ? (
                      <Popup>
                        <SitePopup site={s} />
                      </Popup>
                    ) : null}
                  </CircleMarker>
                ))}
              </LayerGroup>
            </LayersControl.Overlay>
          ) : null}
        </LayersControl>
        <HoverProbe cells={withPsi} onHover={setHover} />
      </MapContainer>

      {/* Color legend */}
      <div className="pointer-events-none absolute bottom-2 left-2 z-[500] rounded bg-white/90 px-2 py-1 text-[10px] shadow">
        <div className="mb-0.5 font-medium">{isRichness ? "Riqueza (especies)" : "ψ ocupación"}</div>
        <div className="flex items-center gap-1">
          <span>0{isRichness ? "" : "%"}</span>
          <span
            className="inline-block h-2 w-24 rounded-sm"
            style={{
              background:
                "linear-gradient(to right, rgb(13,8,135), rgb(126,3,168), rgb(204,71,120), rgb(248,149,64), rgb(240,249,33))",
            }}
          />
          <span>{isRichness ? legend.max.toFixed(1) : "100%"}</span>
        </div>
        {hasDetectionData ? (
          <div className="mt-1 flex items-center gap-3 border-t pt-1">
            <span className="flex items-center gap-1">
              <span
                className="inline-block h-2 w-2 rounded-full border border-white"
                style={{ background: "#059669" }}
              />
              Detectada
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full border border-slate-900 bg-white" />
              No detectada
            </span>
          </div>
        ) : null}
      </div>

      {/* Hover readout */}
      {hover ? (
        <div className="pointer-events-none absolute right-2 top-2 z-[500] rounded bg-white/90 px-2 py-1 text-[11px] shadow">
          {isRichness ? (
            <div>
              Riqueza ={" "}
              {hover.psi != null ? `${(hover.psi * legend.max).toFixed(1)} especies` : "—"}
            </div>
          ) : (
            <>
              <div>
                ψ = {hover.psi != null ? pct(hover.psi) : "—"}
                {hover.lower != null && hover.upper != null
                  ? ` (IC 95%: ${pct(hover.lower)}–${pct(hover.upper)})`
                  : ""}
              </div>
              <div className="text-muted-foreground">
                Bosque {hover.forest != null ? pct(hover.forest) : "—"} · Elev{" "}
                {hover.elevation != null ? `${hover.elevation.toFixed(0)} m` : "—"}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

export default OccupancyMap;
