"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { SortIcon } from "@/components/sort-icon";
import type { ModelInputSample } from "./actions";

type SortKey = "siteName" | "windowStart" | "totalDays" | "occasions" | "detections";
type SortDir = "asc" | "desc";

// Numeric columns default to descending (most first); the site name defaults to
// ascending (A→Z). Clicking the active column toggles the direction.
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  siteName: "asc",
  windowStart: "asc",
  totalDays: "desc",
  occasions: "desc",
  detections: "desc",
};

function SortableTh({
  label,
  colKey,
  activeKey,
  dir,
  onSort,
  align = "right",
  title,
  className = "",
}: {
  label: string;
  colKey: SortKey;
  activeKey: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
  align?: "left" | "right";
  title?: string;
  className?: string;
}) {
  return (
    <th
      className={`px-2 py-1 font-medium cursor-pointer select-none ${
        align === "left" ? "text-left" : "text-right"
      } ${className}`}
      onClick={() => onSort(colKey)}
      title={title}
    >
      <span className={`inline-flex items-center gap-1 ${align === "right" ? "flex-row-reverse" : ""}`}>
        {label}
        <SortIcon direction={activeKey === colKey ? dir : false} />
      </span>
    </th>
  );
}

/**
 * A view of the site × occasion detection matrix the model consumes — lets a
 * reader confirm the site/visit structure is built correctly. Rows = sites
 * (instalaciones), columns = ocasiones (ventanas de tiempo). Cell = 1
 * (detectada), 0 (revisada sin detección) or · (fuera de ventana / NA). Each
 * site also shows its sampling period so an outlier long window — which inflates
 * the occasion count for every site — is visible and flagged. Site names link to
 * the deployment detail page. Every summary column is sortable; the survey-effort
 * level is on each cell's hover title.
 */
export function DetectionSampleTable({ sample }: { sample: ModelInputSample }) {
  const occ = Array.from({ length: sample.maxOccasions }, (_, i) => i + 1);
  const [sortKey, setSortKey] = useState<SortKey>("detections");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(DEFAULT_DIR[key]);
    }
  };

  const rows = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...sample.rows].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "siteName") cmp = a.siteName.localeCompare(b.siteName);
      else if (sortKey === "windowStart") cmp = a.windowStart.localeCompare(b.windowStart);
      else cmp = a[sortKey] - b[sortKey];
      // Stable tiebreaker so equal values keep a deterministic order.
      return cmp !== 0 ? cmp * dir : a.siteId.localeCompare(b.siteId);
    });
  }, [sample.rows, sortKey, sortDir]);

  // A window ≥3× the median (and clearly long) drives maxOccasions and pads
  // every other row with NA — flag it so the culprit is obvious.
  const isOutlier = (days: number) =>
    sample.medianTotalDays > 0 && days >= 3 * sample.medianTotalDays;

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Matriz sitio × ocasión que entra al modelo ({sample.rows.length} sitios; ocasión = ventana
        de {sample.binWidth} días). Cada fila es un sitio; cada columna, una ocasión. El período de
        muestreo (inicio → fin) de cada sitio se muestra a la izquierda; un sitio con una ventana
        muy larga (⚠) ensancha la matriz y deja el resto de filas con NA. Haga clic en un encabezado
        para ordenar.
      </p>
      <div className="overflow-x-auto">
        <table className="text-[11px] border-collapse">
          <thead>
            <tr className="text-muted-foreground">
              <SortableTh
                label="Sitio"
                colKey="siteName"
                activeKey={sortKey}
                dir={sortDir}
                onSort={toggleSort}
                align="left"
                className="sticky left-0 bg-background whitespace-nowrap"
              />
              <SortableTh
                label="Período"
                colKey="windowStart"
                activeKey={sortKey}
                dir={sortDir}
                onSort={toggleSort}
                align="left"
                className="whitespace-nowrap"
              />
              <SortableTh
                label="días"
                colKey="totalDays"
                activeKey={sortKey}
                dir={sortDir}
                onSort={toggleSort}
                title="Días de muestreo (inicio→fin)"
              />
              <SortableTh
                label="oc."
                colKey="occasions"
                activeKey={sortKey}
                dir={sortDir}
                onSort={toggleSort}
                title="Ocasiones muestreadas en este sitio"
              />
              <SortableTh
                label="det."
                colKey="detections"
                activeKey={sortKey}
                dir={sortDir}
                onSort={toggleSort}
                title="Ocasiones con detección"
              />
              {occ.map((o) => (
                <th key={o} className="px-1 py-1 text-center font-normal tabular-nums">
                  {o}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const outlier = isOutlier(r.totalDays);
              return (
                <tr key={r.siteId} className="border-t">
                  <td className="sticky left-0 bg-background px-2 py-1 whitespace-nowrap font-medium">
                    <Link href={r.href} className="text-emerald-700 dark:text-emerald-400 hover:underline">
                      {r.siteName}
                    </Link>
                  </td>
                  <td className="px-2 py-1 whitespace-nowrap tabular-nums text-muted-foreground">
                    {r.windowStart} → {r.windowEnd}
                  </td>
                  <td
                    className={`px-1 py-1 text-right tabular-nums ${
                      outlier ? "text-amber-700 dark:text-amber-400 font-semibold" : "text-muted-foreground"
                    }`}
                    title={
                      outlier
                        ? `Ventana atípicamente larga (${r.totalDays} días; mediana ${sample.medianTotalDays}) — revisar fechas de este sitio`
                        : `${r.totalDays} días de muestreo`
                    }
                  >
                    {outlier ? "⚠ " : ""}
                    {r.totalDays}
                  </td>
                  <td className="px-1 py-1 text-right tabular-nums text-muted-foreground">
                    {r.occasions}
                  </td>
                  <td className="px-1 py-1 text-right tabular-nums text-muted-foreground">
                    {r.detections}
                  </td>
                  {occ.map((o) => {
                    const v = r.cells[o - 1] ?? null;
                    const eff = r.effort[o - 1];
                    const cls =
                      v === 1
                        ? "bg-emerald-600 text-white"
                        : v === 0
                          ? "bg-muted text-muted-foreground"
                          : "text-muted-foreground/40";
                    return (
                      <td
                        key={o}
                        title={eff ? `esfuerzo: ${eff}` : "fuera de ventana (NA)"}
                        className={`px-1 py-1 text-center tabular-nums ${cls}`}
                      >
                        {v === null ? "·" : v}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted-foreground">
        <span className="inline-block align-middle w-3 h-3 rounded-sm bg-emerald-600 mr-1" />1 =
        detectada ·{" "}
        <span className="inline-block align-middle w-3 h-3 rounded-sm bg-muted mr-1" />0 = revisada
        sin detección · <span className="mr-1">·</span> = fuera de la ventana del sitio (NA). Sitio =
        instalación (abre la página de la instalación); ocasión = ventana de {sample.binWidth} días. ⚠
        = ventana de muestreo atípicamente larga.
      </p>
    </div>
  );
}
