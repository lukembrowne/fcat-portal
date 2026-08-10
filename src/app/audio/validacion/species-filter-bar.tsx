"use client";

/**
 * Stage filter and name search for the species table.
 *
 * State lives in the URL alongside the existing `sortBy`/`sortDir`, so a
 * filtered view is shareable and the Server Component keeps doing the work.
 * Each commit copies the current params and touches only its own key, so
 * sorting survives filtering and vice versa.
 *
 * Mirrors `src/app/grants/grants-filter-bar.tsx` rather than importing it: the
 * grant tracking module is deliberately English-only, and lifting a shared
 * component out of it would pull those pages into an unrelated change.
 */

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useTransition } from "react";
import { Loader2, Search } from "lucide-react";

import { STAGE_FILTERS } from "./labels";

const DEFAULT_STAGE = "activas";

export function SpeciesFilterBar({ shown, total }: { shown: number; total: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (debounce.current) clearTimeout(debounce.current);
    },
    []
  );

  function commit(mutate: (sp: URLSearchParams) => void) {
    const sp = new URLSearchParams(params.toString());
    mutate(sp);
    const qs = sp.toString();
    startTransition(() => {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    });
  }

  function commitSearch(value: string) {
    commit((sp) => {
      const v = value.trim();
      if (v) sp.set("search", v);
      else sp.delete("search");
    });
  }

  const stage = params.get("status") ?? DEFAULT_STAGE;

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        // Enter flushes the pending search rather than reloading the page.
        e.preventDefault();
        if (debounce.current) clearTimeout(debounce.current);
        const input = e.currentTarget.elements.namedItem(
          "search"
        ) as HTMLInputElement | null;
        commitSearch(input?.value ?? "");
      }}
    >
      <select
        name="status"
        value={stage}
        onChange={(e) => {
          const next = e.target.value;
          commit((sp) => {
            if (next && next !== DEFAULT_STAGE) sp.set("status", next);
            else sp.delete("status");
          });
        }}
        className="rounded-md border px-2 py-1.5 text-sm"
      >
        {STAGE_FILTERS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      <div className="relative min-w-[200px] flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          name="search"
          type="search"
          defaultValue={params.get("search") ?? ""}
          placeholder="Buscar por nombre científico o común…"
          onChange={(e) => {
            const value = e.target.value;
            if (debounce.current) clearTimeout(debounce.current);
            debounce.current = setTimeout(() => commitSearch(value), 300);
          }}
          className="w-full rounded-md border py-1.5 pl-8 pr-8 text-sm"
        />
        {pending ? (
          <Loader2 className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
        ) : null}
      </div>

      {/* Says what is hidden. A filtered table that silently shows 3 of 35 rows
          reads as a species having been deleted. */}
      <span className="text-xs tabular-nums text-muted-foreground">
        {shown === total ? `${total} especies` : `${shown} de ${total}`}
      </span>
    </form>
  );
}
