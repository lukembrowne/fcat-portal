"use client";

/**
 * Live filter bar for the /grants and /grants/funders tables. Replaces the old
 * `<form method="GET">` + "Filter" button: the dropdown and checkbox commit
 * instantly, the search box debounces at 300ms, and pressing Enter flushes the
 * search immediately. State lives in the URL (`router.replace(..., { scroll: false })`)
 * so the React Server Component re-fetches via a soft navigation — server-side
 * filtering, sortable headers, and shareable/deep-linkable URLs all keep working.
 *
 * Each commit copies the current params and only sets/deletes the one changed key,
 * so `sortBy`/`sortDir` and the other filter are always preserved. An empty search,
 * an unchecked box, or the "all" option deletes its param to keep URLs clean.
 *
 * NOTE: The grant tracking module is intentionally in ENGLISH.
 */

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useTransition } from "react";
import { Loader2, Search } from "lucide-react";

interface SelectFilter {
  /** URL param + <select> name, e.g. "status" or "priority". */
  name: string;
  /** Label for the "all" option, e.g. "All statuses". */
  allLabel: string;
  options: { value: string; label: string }[];
}

interface CheckboxFilter {
  /** URL param + checkbox name, e.g. "needsLinking". */
  name: string;
  label: string;
  /** Value written to the URL when checked, e.g. "1". */
  value: string;
}

export function GrantsFilterBar({
  select,
  searchPlaceholder,
  checkbox,
}: {
  select: SelectFilter;
  searchPlaceholder: string;
  checkbox?: CheckboxFilter;
}) {
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

  function onSearchChange(value: string) {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => commitSearch(value), 300);
  }

  const selectValue = params.get(select.name) ?? "all";

  return (
    <form
      className="flex gap-3 flex-wrap"
      onSubmit={(e) => {
        // Enter flushes the pending search immediately instead of reloading.
        e.preventDefault();
        if (debounce.current) clearTimeout(debounce.current);
        const input = e.currentTarget.elements.namedItem(
          "search"
        ) as HTMLInputElement | null;
        commitSearch(input?.value ?? "");
      }}
    >
      <select
        name={select.name}
        value={selectValue}
        onChange={(e) => {
          const next = e.target.value;
          commit((sp) => {
            if (next && next !== "all") sp.set(select.name, next);
            else sp.delete(select.name);
          });
        }}
        className="rounded-md border px-3 py-2 text-sm"
      >
        <option value="all">{select.allLabel}</option>
        {select.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      <div className="relative flex-1 min-w-[200px]">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          name="search"
          type="search"
          defaultValue={params.get("search") ?? ""}
          placeholder={searchPlaceholder}
          onChange={(e) => onSearchChange(e.target.value)}
          className="w-full rounded-md border pl-8 pr-8 py-2 text-sm"
        />
        {pending && (
          <Loader2 className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
        )}
      </div>

      {checkbox && (
        <label className="flex items-center gap-2 text-sm px-2">
          <input
            type="checkbox"
            name={checkbox.name}
            value={checkbox.value}
            checked={params.get(checkbox.name) === checkbox.value}
            onChange={(e) => {
              const on = e.target.checked;
              commit((sp) => {
                if (on) sp.set(checkbox.name, checkbox.value);
                else sp.delete(checkbox.name);
              });
            }}
          />
          {checkbox.label}
        </label>
      )}
    </form>
  );
}
