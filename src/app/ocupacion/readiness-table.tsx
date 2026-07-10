"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { SortIcon } from "@/components/sort-icon";
import type { ReadinessSpeciesRow, OccupancyStream } from "@/lib/occupancy/readiness";

/** Fitted ψ + p per species (from the latest completed run), keyed by species. */
export type ModeledMap = Map<string, { psi: number | null; p: number | null }>;

type SortKey =
  | "species"
  | "nSites"
  | "nSitesDetected"
  | "totalDetections"
  | "maxOccasions"
  | "naiveOccupancy"
  | "modeledP"
  | "modeledPsi"
  | "eligible";

const COLUMNS: { key: SortKey; label: string; numeric: boolean; title?: string }[] = [
  { key: "species", label: "Especie", numeric: false },
  { key: "nSitesDetected", label: "Sitios con detección", numeric: true },
  { key: "nSites", label: "Sitios muestreados", numeric: true },
  {
    key: "totalDetections",
    label: "Detecciones",
    numeric: true,
    title: "Detecciones dentro de la ventana de muestreo (ocasiones), no el total histórico",
  },
  { key: "maxOccasions", label: "Ocasiones", numeric: true },
  { key: "naiveOccupancy", label: "Ocupación ingenua", numeric: true },
  {
    key: "modeledP",
    label: "p (modelada)",
    numeric: true,
    title: "Probabilidad de detección estimada por el modelo (— si aún no se modela)",
  },
  {
    key: "modeledPsi",
    label: "ψ (modelada)",
    numeric: true,
    title: "Ocupación estimada por el modelo (— si aún no se modela)",
  },
  { key: "eligible", label: "Estado", numeric: false },
];

type Row = ReadinessSpeciesRow & { modeledP: number | null; modeledPsi: number | null };

export function ReadinessTable({
  rows,
  stream,
  modeled,
}: {
  rows: ReadinessSpeciesRow[];
  stream: OccupancyStream;
  modeled: ModeledMap;
}) {
  // Default: eligible first, then most-spread — matches the action's ordering.
  const [sortKey, setSortKey] = useState<SortKey>("nSitesDetected");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const merged: Row[] = useMemo(
    () =>
      rows.map((r) => {
        const m = modeled.get(r.species);
        return { ...r, modeledP: m?.p ?? null, modeledPsi: m?.psi ?? null };
      }),
    [rows, modeled],
  );

  const sorted = useMemo(() => {
    const copy = [...merged];
    copy.sort((a, b) => {
      let cmp: number;
      if (sortKey === "species") {
        cmp = a.species.localeCompare(b.species);
      } else if (sortKey === "eligible") {
        cmp = (a.eligible ? 1 : 0) - (b.eligible ? 1 : 0);
      } else {
        const av = a[sortKey] as number | null;
        const bv = b[sortKey] as number | null;
        // Nulls (unmodeled p/ψ) always sort last regardless of direction.
        if (av == null && bv == null) cmp = 0;
        else if (av == null) return 1;
        else if (bv == null) return -1;
        else cmp = av - bv;
      }
      // Stable tiebreaker on species so re-sorts don't jitter.
      if (cmp === 0) cmp = a.species.localeCompare(b.species);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [merged, sortKey, sortDir]);

  const toggle = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "species" ? "asc" : "desc");
    }
  };

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4">
        No hay detecciones para esta fuente todavía.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {COLUMNS.map((c) => (
                <TableHead key={c.key} className={c.numeric ? "text-right" : ""}>
                  <button
                    type="button"
                    onClick={() => toggle(c.key)}
                    title={c.title}
                    className={`inline-flex items-center gap-1 hover:text-foreground ${
                      c.numeric ? "flex-row-reverse" : ""
                    }`}
                  >
                    {c.label}
                    <SortIcon direction={sortKey === c.key ? sortDir : false} />
                  </button>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((r) => {
              const isModeled = r.modeledPsi != null || r.modeledP != null;
              return (
                <TableRow key={r.species}>
                  <TableCell className="font-medium italic">
                    {isModeled ? (
                      <Link
                        href={`/ocupacion/${encodeURIComponent(r.species)}?stream=${stream}`}
                        className="text-emerald-700 dark:text-emerald-400 hover:underline"
                      >
                        {r.species}
                      </Link>
                    ) : (
                      r.species
                    )}
                  </TableCell>
                  <TableCell className="text-right">{r.nSitesDetected}</TableCell>
                  <TableCell className="text-right">{r.nSites}</TableCell>
                  <TableCell className="text-right">{r.totalDetections}</TableCell>
                  <TableCell className="text-right">{r.maxOccasions}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {(r.naiveOccupancy * 100).toFixed(0)}%
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.modeledP != null ? r.modeledP.toFixed(2) : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.modeledPsi != null ? `${(r.modeledPsi * 100).toFixed(0)}%` : "—"}
                  </TableCell>
                  <TableCell>
                    {r.eligible ? (
                      <Badge className="bg-emerald-600 hover:bg-emerald-600">
                        Listo para modelar
                      </Badge>
                    ) : (
                      <div className="space-y-1">
                        <Badge
                          variant="outline"
                          className="border-amber-500 text-amber-700 dark:text-amber-400"
                        >
                          Datos insuficientes
                        </Badge>
                        <ul className="text-xs text-muted-foreground list-disc pl-4">
                          {r.reasons.map((reason, i) => (
                            <li key={i}>{reason}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <p className="text-[11px] text-muted-foreground">
        <strong>Detecciones</strong> = detecciones dentro de la ventana de muestreo (ocasiones)
        usada por el modelo, no el total histórico. <strong>p</strong> y <strong>ψ</strong> son las
        estimaciones del modelo (— si la especie aún no se modela).
      </p>
    </div>
  );
}
