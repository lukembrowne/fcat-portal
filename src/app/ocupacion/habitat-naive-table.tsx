"use client";

import { useMemo, useState } from "react";
import { SortIcon } from "@/components/sort-icon";
import type { HabitatNaiveRow } from "@/lib/occupancy/habitat-summary";

type SortKey = "habitat" | "nSurveyed" | "nDetected" | "naiveOccupancy";
type SortDir = "asc" | "desc";

// Numeric columns default to descending (most first); habitat name to ascending.
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  habitat: "asc",
  nSurveyed: "desc",
  nDetected: "desc",
  naiveOccupancy: "desc",
};

function SortableTh({
  label,
  colKey,
  activeKey,
  dir,
  onSort,
  align = "right",
  title,
}: {
  label: string;
  colKey: SortKey;
  activeKey: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
  align?: "left" | "right";
  title?: string;
}) {
  return (
    <th
      className={`px-2 py-1 font-medium cursor-pointer select-none ${
        align === "left" ? "text-left" : "text-right"
      }`}
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
 * Observed (naïve) occupancy by habitat — the fraction of surveyed sites with
 * ≥1 detection of this species, per habitat class. A pure count, no model, so it
 * still describes habitat association when the categorical habitat occupancy
 * model is non-identifiable (e.g. a species found in only one habitat, which
 * separates the fit). Every column is sortable; the inline bar visualizes the
 * observed occupancy fraction.
 */
export function HabitatNaiveTable({ rows }: { rows: HabitatNaiveRow[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("naiveOccupancy");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(DEFAULT_DIR[key]);
    }
  };

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const cmp =
        sortKey === "habitat"
          ? a.habitat.localeCompare(b.habitat)
          : (a[sortKey] as number) - (b[sortKey] as number);
      // Stable tiebreaker so equal values keep a deterministic order.
      return cmp !== 0 ? cmp * dir : a.habitat.localeCompare(b.habitat);
    });
  }, [rows, sortKey, sortDir]);

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-muted-foreground">
              <SortableTh label="Hábitat" colKey="habitat" activeKey={sortKey} dir={sortDir} onSort={toggleSort} align="left" />
              <SortableTh label="sitios" colKey="nSurveyed" activeKey={sortKey} dir={sortDir} onSort={toggleSort} title="Sitios muestreados de este hábitat" />
              <SortableTh label="con det." colKey="nDetected" activeKey={sortKey} dir={sortDir} onSort={toggleSort} title="Sitios con ≥1 detección" />
              <SortableTh label="ocupación observada" colKey="naiveOccupancy" activeKey={sortKey} dir={sortDir} onSort={toggleSort} title="Fracción de sitios con detección (sin modelo)" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.habitat} className="border-t">
                <td className="px-2 py-1 whitespace-nowrap font-medium">{r.habitat}</td>
                <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{r.nSurveyed}</td>
                <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{r.nDetected}</td>
                <td className="px-2 py-1 text-right tabular-nums">
                  <span className="inline-flex items-center justify-end gap-2">
                    <span className="relative inline-block h-2 w-16 overflow-hidden rounded-sm bg-muted align-middle">
                      <span
                        className="absolute inset-y-0 left-0 bg-emerald-600"
                        style={{ width: `${Math.round(r.naiveOccupancy * 100)}%` }}
                      />
                    </span>
                    <span className="w-10 text-right">{Math.round(r.naiveOccupancy * 100)}%</span>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Ocupación observada = fracción de sitios muestreados con ≥1 detección, por hábitat (conteo
        directo, sin modelo — entre sitios con hábitat asignado). Complementa el modelo de uso de
        hábitat y lo reemplaza cuando ese modelo no es identificable.
      </p>
    </div>
  );
}
