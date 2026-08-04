"use client";

/**
 * "Fichas de especies" — the authoring surface for the shared per-species text
 * that appears on every public finca page.
 *
 * Card list rather than a table: each species' text box is always open and
 * saved in place, because the job here is writing ~63 fichas from scratch, not
 * editing existing ones (production: 607 species rows, 63 with any verified
 * detection, 1 with content). A modal per species was the wrong shape for that.
 *
 * The default scope is deliberately "con registros" — only species with a
 * verified detection can appear on a finca page, so the ~544-row BirdNET
 * audio-only bird tail is behind a toggle instead of burying the work.
 */

import { useState, useMemo, useCallback, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { SortIcon } from "@/components/sort-icon";
import { SpeciesCard } from "./species-card";
import type { SpeciesContentRow } from "./content-types";
import {
  buildVisibleSections,
  type SortKey,
  type SortDir,
  type SpeciesScope,
} from "./list-view";

/** Cards rendered before "Mostrar más". Only bites in the "Todas" scope. */
const CHUNK = 100;

const SORT_OPTIONS: { key: SortKey; label: string; defaultDir: SortDir }[] = [
  { key: "records", label: "Registros", defaultDir: "desc" },
  { key: "name", label: "Nombre", defaultDir: "asc" },
  { key: "type", label: "Tipo", defaultDir: "asc" },
  { key: "status", label: "Ficha", defaultDir: "asc" },
];

interface Props {
  species: SpeciesContentRow[];
}

export function FichasEspeciesClient({ species }: Props) {
  const [rows, setRows] = useState<SpeciesContentRow[]>(species);
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<SpeciesScope>("withRecords");
  const [sortKey, setSortKey] = useState<SortKey>("records");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [dirtyIds, setDirtyIds] = useState<ReadonlySet<number>>(new Set());
  const [limit, setLimit] = useState(CHUNK);

  // Reset the render window whenever the visible set changes underneath it.
  const filterKey = `${search}|${scope}|${sortKey}|${sortDir}`;
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (filterKey !== lastFilterKey) {
    setLastFilterKey(filterKey);
    setLimit(CHUNK);
  }

  const { matching, pinned } = useMemo(
    () =>
      buildVisibleSections(rows, {
        search,
        scope,
        sortKey,
        sortDir,
        alwaysInclude: dirtyIds,
      }),
    [rows, search, scope, sortKey, sortDir, dirtyIds]
  );

  // Pinned (dirty) cards render OUTSIDE the chunk cap. Capping them too would
  // let a card holding unsaved text fall past the window and unmount — exactly
  // what pinning exists to prevent.
  const shown = matching.slice(0, limit);
  const hiddenCount = matching.length - shown.length;

  const withContent = matching.filter((r) => r.hasContent).length;

  const handleSaved = useCallback((id: number, publicContent: string | null) => {
    setRows((rs) =>
      rs.map((r) =>
        r.id === id
          ? { ...r, publicContent, hasContent: !!publicContent?.trim() }
          : r
      )
    );
  }, []);

  const handleDirtyChange = useCallback((id: number, dirty: boolean) => {
    setDirtyIds((prev) => {
      if (prev.has(id) === dirty) return prev;
      const next = new Set(prev);
      if (dirty) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  useEffect(() => {
    if (dirtyIds.size === 0) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirtyIds.size]);

  const toggleSort = (key: SortKey) => {
    const option = SORT_OPTIONS.find((o) => o.key === key);
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(option?.defaultDir ?? "asc");
    }
  };

  return (
    <>
      <header className="mb-5">
        <h1 className="text-2xl font-bold">Fichas de especies</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Texto que aparece en las páginas públicas de las fincas. Es el mismo
          para todos los sitios: al editarlo aquí se actualiza en todas las
          páginas que muestran esa especie.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {withContent} de {matching.length} especies con ficha
          {dirtyIds.size > 0 && (
            <span className="ml-2 text-amber-600">
              · {dirtyIds.size} sin guardar
            </span>
          )}
        </p>
      </header>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Input
          placeholder="Buscar por nombre científico, común o español..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="sm:max-w-xs"
        />

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex rounded-md border text-xs">
            {(
              [
                ["withRecords", "Con registros"],
                ["all", "Todas"],
              ] as const
            ).map(([value, label], i) => (
              <button
                key={value}
                type="button"
                onClick={() => setScope(value)}
                className={`px-2.5 py-1.5 ${i === 0 ? "rounded-l-md" : "rounded-r-md"} ${
                  scope === value
                    ? "bg-foreground text-background"
                    : "hover:bg-muted"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap gap-1 text-xs">
            {SORT_OPTIONS.map((o) => (
              <button
                key={o.key}
                type="button"
                onClick={() => toggleSort(o.key)}
                className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 ${
                  sortKey === o.key
                    ? "bg-foreground text-background"
                    : "hover:bg-muted"
                }`}
              >
                {o.label}
                <SortIcon direction={sortKey === o.key ? sortDir : false} />
              </button>
            ))}
          </div>
        </div>
      </div>

      {matching.length === 0 && pinned.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          No se encontraron especies
        </p>
      ) : (
        <div className="space-y-3">
          {shown.map((s) => (
            <SpeciesCard
              key={s.id}
              species={s}
              onDirtyChange={handleDirtyChange}
              onSaved={handleSaved}
            />
          ))}

          {pinned.length > 0 && (
            <>
              <p className="pt-2 text-xs text-muted-foreground">
                Fuera del filtro actual, con cambios sin guardar:
              </p>
              {pinned.map((s) => (
                <SpeciesCard
                  key={s.id}
                  species={s}
                  onDirtyChange={handleDirtyChange}
                  onSaved={handleSaved}
                />
              ))}
            </>
          )}

          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setLimit((l) => l + CHUNK)}
              className="w-full rounded-lg border border-dashed py-3 text-sm text-muted-foreground hover:bg-muted"
            >
              Mostrar más ({hiddenCount} restantes)
            </button>
          )}
        </div>
      )}
    </>
  );
}
