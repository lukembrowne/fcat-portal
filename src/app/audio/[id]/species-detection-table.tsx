"use client";

import { useMemo, useState } from "react";
import { SortIcon } from "@/components/sort-icon";

export interface SpeciesTableRow {
  scientificName: string;
  spanishName: string | null;
  commonName: string | null;
  detectionCount: number;
  avgConfidence: number | null;
}

type SortKey = "name" | "common" | "detections" | "confidence";
type SortDir = "asc" | "desc";

function displayName(r: SpeciesTableRow): string | null {
  return r.spanishName ?? r.commonName ?? null;
}

const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: "name", label: "Especie", numeric: false },
  { key: "common", label: "Nombre común", numeric: false },
  { key: "detections", label: "Detecciones", numeric: true },
  { key: "confidence", label: "Confianza media", numeric: true },
];

export function SpeciesDetectionTable({
  species,
  analyzed,
}: {
  species: SpeciesTableRow[];
  /** Whether BirdNET has been run on this deployment — distinguishes
   *  "not analyzed yet" from "analyzed but nothing above the threshold". */
  analyzed: boolean;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("detections");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const sorted = useMemo(() => {
    const rows = [...species];
    const dir = sortDir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "name":
          cmp = a.scientificName.localeCompare(b.scientificName);
          break;
        case "common":
          cmp = (displayName(a) ?? "").localeCompare(displayName(b) ?? "");
          break;
        case "detections":
          cmp = a.detectionCount - b.detectionCount;
          break;
        case "confidence":
          // Null confidence sorts last regardless of direction.
          if (a.avgConfidence == null && b.avgConfidence == null) cmp = 0;
          else if (a.avgConfidence == null) return 1;
          else if (b.avgConfidence == null) return -1;
          else cmp = a.avgConfidence - b.avgConfidence;
          break;
      }
      // Stable, deterministic tiebreaker on scientific name.
      if (cmp === 0) return a.scientificName.localeCompare(b.scientificName);
      return cmp * dir;
    });
    return rows;
  }, [species, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Numeric columns default to descending (most detections first); text
      // columns default to ascending (A–Z).
      setSortDir(key === "detections" || key === "confidence" ? "desc" : "asc");
    }
  }

  if (species.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {analyzed
          ? "No hay detecciones para este umbral de confianza."
          : "Sin analizar. Ejecuta BirdNET para ver las especies detectadas."}
      </p>
    );
  }

  const totalDetections = species.reduce((sum, s) => sum + s.detectionCount, 0);

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        {species.length} {species.length === 1 ? "especie" : "especies"} ·{" "}
        {totalDetections.toLocaleString("es-ES")} detecciones
      </p>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-left">
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  className={`px-3 py-2 font-medium ${col.numeric ? "text-right" : ""}`}
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(col.key)}
                    className={`inline-flex items-center gap-1 hover:text-foreground ${
                      col.numeric ? "flex-row-reverse" : ""
                    }`}
                  >
                    {col.label}
                    <SortIcon
                      direction={sortKey === col.key ? sortDir : undefined}
                    />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => (
              <tr key={s.scientificName} className="border-b last:border-0">
                <td className="px-3 py-2 italic">{s.scientificName}</td>
                <td className="px-3 py-2 text-muted-foreground">
                  {displayName(s) ?? "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {s.detectionCount.toLocaleString("es-ES")}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {s.avgConfidence != null ? s.avgConfidence.toFixed(2) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
