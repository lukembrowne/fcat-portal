"use client";

/**
 * Faithful port of the standalone report's interactive map: satellite base
 * layer, deployment points colored by habitat, dashed FCAT reserve boundary,
 * per-site popups, and a habitat legend.
 *
 * Vanilla Leaflet (not react-leaflet) so the known-good init sequence is
 * preserved — `setView(...)` MUST run before any layer is added or the canvas
 * renderer throws "Cannot read properties of undefined (reading 'min')", and
 * `preferCanvas:true` makes rendering (and headless-Chrome screenshots) reliable.
 * The component is imported via `next/dynamic({ ssr:false })` because Leaflet
 * touches `window` at module load.
 */

import { useEffect, useRef } from "react";
import type { Lang } from "./lib/snapshot-types";
import type { DeploymentPoint } from "./lib/snapshot-types";
import { HABITAT, type HabitatKey } from "./lib/habitat";
import { legendRows, markerColor } from "./lib/map-helpers";
import "leaflet/dist/leaflet.css";

export function OverviewMap({
  deployments,
  habitatCounts,
  legendTitle,
  lang,
}: {
  deployments: DeploymentPoint[];
  habitatCounts: Record<string, number>;
  legendTitle: string;
  lang: Lang;
}) {
  const elRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    let cancelled = false;
    let map: import("leaflet").Map | null = null;

    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled || !el) return;

      // setView BEFORE adding any layer (see file header).
      map = L.map(el, { scrollWheelZoom: false, zoomControl: true, preferCanvas: true }).setView(
        [0.38, -79.68],
        11,
      );

      const sat = L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        { maxZoom: 19, attribution: "Imagery © Esri, Maxar, Earthstar Geographics" },
      );
      const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "© OpenStreetMap contributors",
      });
      sat.addTo(map);
      L.control.layers({ Satellite: sat, "Street map": osm }, undefined, { position: "topright" }).addTo(map);

      // Reserve boundary (static asset). Best-effort — never block the map.
      try {
        const res = await fetch("/biochoco-overview/reserve.geojson");
        if (res.ok && map) {
          const geo = await res.json();
          L.geoJSON(geo, {
            style: { color: "#8ce07a", weight: 2, dashArray: "6 5", fill: false, opacity: 0.9 },
          }).addTo(map);
        }
      } catch {
        /* boundary is decorative; ignore fetch/parse errors */
      }

      const pts = deployments.filter((d) => d.lat != null && d.lng != null);
      const markers: import("leaflet").CircleMarker[] = [];
      for (const d of pts) {
        const habName = (HABITAT[d.habitat as HabitatKey] ?? HABITAT.unknown).name[lang];
        const m = L.circleMarker([d.lat as number, d.lng as number], {
          radius: 7,
          color: "#fff",
          weight: 1.3,
          fillColor: markerColor(d.habitat),
          fillOpacity: 0.9,
        })
          .addTo(map!)
          .bindPopup(`<div class="pt">${d.code}</div>` + `<div class="pr">${habName}</div>`);
        markers.push(m);
      }
      if (markers.length) {
        // A handful of far-flung deployments would otherwise force a wide,
        // zoomed-out view. Frame the core 90% of sites (5th–95th percentile on
        // each axis) so the network reads up-close; outliers stay plotted and
        // a short pan away.
        const lats = pts.map((d) => d.lat as number).sort((a, b) => a - b);
        const lngs = pts.map((d) => d.lng as number).sort((a, b) => a - b);
        const q = (arr: number[], p: number) =>
          arr[Math.min(arr.length - 1, Math.max(0, Math.round(p * (arr.length - 1))))];
        const core = L.latLngBounds(
          [q(lats, 0.05), q(lngs, 0.05)],
          [q(lats, 0.95), q(lngs, 0.95)],
        );
        map.fitBounds(core.pad(0.08), { maxZoom: 15 });
      }
    })();

    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [deployments, lang]);

  const rows = legendRows(habitatCounts);

  return (
    <div className="map-shell">
      <div id="map" ref={elRef} />
      <div className="legend">
        <b>{legendTitle}</b>
        <div>
          {rows.map((k) => (
            <div className="row" key={k}>
              <span className="sw" style={{ background: HABITAT[k].color }} />
              {HABITAT[k].name[lang]}
              <span className="c">{habitatCounts[k]}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default OverviewMap;
