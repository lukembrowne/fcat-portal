"use client";

/**
 * Searchable picker over the species BirdNET has actually detected.
 *
 * Replaces the free-text box that used to be the only way to start a
 * validation: it offered no candidates, no detection counts, and accepted a
 * typo silently — producing a species that can never draw a sample.
 *
 * cmdk's own filtering is switched off (`shouldFilter={false}`) so the ordering
 * rules below are the ones that run. They live in a pure exported function
 * because Vitest runs in a `node` environment with no DOM, and a pure resolver
 * is the only way to cover match ordering without pulling in jsdom — the same
 * constraint that shaped `resolveReviewKey` and `sortCampaignRows`.
 */

import { useEffect, useMemo, useState } from "react";
import { Check, Loader2 } from "lucide-react";

import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { stageLabel } from "./labels";
import { normalizeSpeciesName } from "./species-import";
import type { ValidatableSpecies } from "./actions";

/**
 * Shared with the bulk importer so search and import agree on what counts as
 * the same name — see `normalizeSpeciesName`.
 */
export { normalizeSpeciesName as normalizeForSearch };

function haystacks(sp: ValidatableSpecies): string[] {
  return [sp.scientificName, sp.commonName ?? "", sp.spanishName ?? ""]
    .filter(Boolean)
    .map(normalizeSpeciesName);
}

/**
 * Match and order the catalog for a query.
 *
 * A species already under validation is kept in the results and marked
 * unselectable by the caller rather than filtered out — a reader who searches
 * for it and finds nothing concludes it is missing from the catalog, not that
 * it is already being worked on.
 */
export function filterSpecies(
  catalog: ValidatableSpecies[],
  query: string
): ValidatableSpecies[] {
  const q = normalizeSpeciesName(query);

  const scored = catalog
    .map((sp) => {
      if (!q) return { sp, rank: 0 };
      const fields = haystacks(sp);
      if (fields.some((f) => f.startsWith(q))) return { sp, rank: 0 };
      if (fields.some((f) => f.includes(q))) return { sp, rank: 1 };
      return null;
    })
    .filter((x): x is { sp: ValidatableSpecies; rank: number } => x !== null);

  scored.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.sp.detectionCount !== b.sp.detectionCount) {
      return b.sp.detectionCount - a.sp.detectionCount;
    }
    // Stable tiebreaker so the list does not reshuffle between keystrokes.
    return a.sp.scientificName.localeCompare(b.sp.scientificName);
  });

  return scored.map((x) => x.sp);
}

/** Rows rendered at once. Beyond this the query is too broad to scan anyway. */
const MAX_VISIBLE = 80;

export function SpeciesPicker({
  catalog,
  loading,
  selected,
  onSelect,
}: {
  catalog: ValidatableSpecies[];
  loading: boolean;
  selected: string | null;
  onSelect: (scientificName: string) => void;
}) {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => filterSpecies(catalog, query), [catalog, query]);
  const visible = matches.slice(0, MAX_VISIBLE);

  return (
    <Command loop shouldFilter={false} className="rounded-md border">
      <CommandInput
        placeholder="Busca por nombre científico o común…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList className="max-h-64">
        {loading ? (
          <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Cargando especies…
          </div>
        ) : matches.length === 0 ? (
          <CommandEmpty>
            Ninguna especie detectada coincide con la búsqueda.
          </CommandEmpty>
        ) : (
          <>
            {visible.map((sp) => {
              const taken = sp.activeStatus != null;
              return (
                <CommandItem
                  key={sp.scientificName}
                  value={sp.scientificName}
                  disabled={taken}
                  onSelect={() => !taken && onSelect(sp.scientificName)}
                  className="flex items-start justify-between gap-2"
                >
                  <span className="min-w-0">
                    <span className="block truncate">
                      {sp.spanishName ?? sp.commonName ?? sp.scientificName}
                    </span>
                    <span className="block truncate text-[11px] italic text-muted-foreground">
                      {sp.scientificName}
                    </span>
                    {taken ? (
                      <span className="block text-[11px] text-amber-700">
                        Ya en validación · {stageLabel(sp.activeStatus!)}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {sp.detectionCount.toLocaleString("es")} det.
                    {selected === sp.scientificName ? (
                      <Check className="ml-1 inline h-3 w-3" />
                    ) : null}
                  </span>
                </CommandItem>
              );
            })}
            {matches.length > visible.length ? (
              <p className="px-3 py-2 text-[11px] text-muted-foreground">
                Mostrando {visible.length} de {matches.length}. Afina la búsqueda
                para ver el resto.
              </p>
            ) : null}
          </>
        )}
      </CommandList>
    </Command>
  );
}

/** Load the catalog once, lazily — it is ~550 rows and only needed on open. */
export function useSpeciesCatalog(enabled: boolean) {
  const [catalog, setCatalog] = useState<ValidatableSpecies[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || catalog.length > 0 || loading) return;
    let cancelled = false;
    setLoading(true);
    void import("./actions")
      .then((m) => m.listValidatableSpecies())
      .then((result) => {
        if (cancelled) return;
        if (result.success) setCatalog(result.data);
        else setError(result.error);
      })
      .catch(() => !cancelled && setError("No se pudo cargar la lista de especies"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [enabled, catalog.length, loading]);

  return { catalog, loading, error };
}
