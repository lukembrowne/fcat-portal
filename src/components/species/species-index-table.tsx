"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import type { SpeciesIndexRow } from "@/app/camera-trap/species/actions";
import { speciesSlug } from "@/lib/species-slug";
import { Input } from "@/components/ui/input";
import { IucnCode } from "@/components/iucn-code";

interface SpeciesIndexTableProps {
  rows: SpeciesIndexRow[];
  /** Base path for a row link, e.g. "/camera-trap/species" or "/audio/species". */
  basePath: string;
  emptyState?: string;
}

type SortKey = "count" | "name";

function stripDiacritics(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function formatDate(unixSeconds: number | null): string {
  if (!unixSeconds) return "—";
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleDateString("es-EC", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function SpeciesIndexTable({ rows, basePath, emptyState }: SpeciesIndexTableProps) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("count");
  const [, startTransition] = useTransition();

  const filtered = useMemo(() => {
    const needle = stripDiacritics(search.trim());
    let list = rows;
    if (needle) {
      list = list.filter((r) => {
        const haystacks = [
          stripDiacritics(r.scientificName),
          stripDiacritics(r.commonName),
          r.spanishName ? stripDiacritics(r.spanishName) : "",
        ];
        return haystacks.some((h) => h.includes(needle));
      });
    }
    const sorted = [...list];
    if (sort === "count") {
      sorted.sort(
        (a, b) =>
          b.detectionCount - a.detectionCount ||
          a.scientificName.localeCompare(b.scientificName)
      );
    } else {
      sorted.sort((a, b) =>
        a.commonName.localeCompare(b.commonName, "es") ||
        a.scientificName.localeCompare(b.scientificName)
      );
    }
    return sorted;
  }, [rows, search, sort]);

  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground text-sm py-8 text-center">
        {emptyState ??
          "No hay especies con detecciones en los proyectos a los que tienes acceso."}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
        <Input
          placeholder="Buscar especie..."
          value={search}
          onChange={(e) =>
            startTransition(() => setSearch(e.target.value))
          }
          className="sm:max-w-sm"
        />
        <div className="flex gap-1 text-sm">
          <button
            type="button"
            onClick={() => setSort("count")}
            className={`px-3 py-1.5 rounded-md border ${
              sort === "count"
                ? "bg-foreground text-background"
                : "bg-background"
            }`}
          >
            Por detecciones
          </button>
          <button
            type="button"
            onClick={() => setSort("name")}
            className={`px-3 py-1.5 rounded-md border ${
              sort === "name"
                ? "bg-foreground text-background"
                : "bg-background"
            }`}
          >
            Alfabético
          </button>
        </div>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr className="text-left">
              <th className="px-3 py-2 font-medium">Especie</th>
              <th className="px-3 py-2 font-medium text-right">Detecciones</th>
              <th className="px-3 py-2 font-medium text-right">Sitios</th>
              <th className="px-3 py-2 font-medium text-right hidden md:table-cell">
                Última detección
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr
                key={r.scientificName}
                className="border-t hover:bg-muted/30"
              >
                <td className="px-3 py-2">
                  <Link
                    href={`${basePath}/${speciesSlug(r.scientificName)}`}
                    className="block"
                  >
                    <div className="font-medium flex items-center gap-1.5">
                      <span>{r.commonName}</span>
                      <IucnCode status={r.iucnStatus} />
                    </div>
                    <div className="text-xs text-muted-foreground italic">
                      {r.scientificName}
                      {r.spanishName ? ` · ${r.spanishName}` : ""}
                    </div>
                  </Link>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.detectionCount.toLocaleString("es-EC")}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.siteCount}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground hidden md:table-cell">
                  {formatDate(r.lastSeen)}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={4}
                  className="px-3 py-6 text-center text-muted-foreground"
                >
                  Sin resultados para &ldquo;{search}&rdquo;.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        {filtered.length} de {rows.length} especies
      </p>
    </div>
  );
}
