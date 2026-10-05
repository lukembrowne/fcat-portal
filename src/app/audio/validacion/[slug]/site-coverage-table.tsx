"use client";

import { useMemo, useState } from "react";

import { SortIcon } from "@/components/sort-icon";
import type { SiteCoverage } from "@/app/audio/validacion/actions";

export type SiteSortKey = "site" | "drawn" | "reviewed" | "correct";
type SortDir = "asc" | "desc";

/**
 * Pure sort for the "Cobertura por sitio" table. The site name is the row's
 * identity (one row per site), so it is the stable tiebreak; the unnamed site
 * sorts last on name in both directions.
 */
export function sortSiteCoverage(
  sites: SiteCoverage[],
  key: SiteSortKey,
  dir: SortDir
): SiteCoverage[] {
  const sign = dir === "asc" ? 1 : -1;
  const byName = (a: SiteCoverage, b: SiteCoverage) => {
    if (a.siteName === b.siteName) return 0;
    if (a.siteName === null) return 1;
    if (b.siteName === null) return -1;
    return a.siteName.localeCompare(b.siteName);
  };
  return [...sites].sort((a, b) => {
    if (key === "site") {
      if (a.siteName === null || b.siteName === null) return byName(a, b);
      return byName(a, b) * sign;
    }
    // A withheld count (null) sorts as below zero, so it never outranks a
    // real one; in practice the whole column is null or none of it is.
    const cmp = (a[key] ?? -1) - (b[key] ?? -1);
    return cmp !== 0 ? cmp * sign : byName(a, b);
  });
}

export function SiteCoverageTable({
  sites,
  showCorrect,
}: {
  sites: SiteCoverage[];
  /**
   * False when the per-site correct counts are withheld — the fit-eligible
   * reviews cannot be resolved (several reviewers, no primary), or the reader
   * is still blind to them. The column shows a dash; the counts are null in
   * the payload anyway.
   */
  showCorrect: boolean;
}) {
  const [sortKey, setSortKey] = useState<SiteSortKey>("drawn");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const sorted = useMemo(
    () => sortSiteCoverage(sites, sortKey, sortDir),
    [sites, sortKey, sortDir]
  );

  const toggle = (key: SiteSortKey) => {
    if (key === sortKey) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(key === "site" ? "asc" : "desc");
    }
  };

  const header = (key: SiteSortKey, label: string, right = true) => (
    <th className={`py-1 ${right ? "pl-2 text-right" : ""}`}>
      <button
        type="button"
        onClick={() => toggle(key)}
        className={`inline-flex items-center gap-1 hover:text-foreground ${
          right ? "flex-row-reverse" : ""
        }`}
      >
        {label}
        <SortIcon direction={sortKey === key ? sortDir : false} />
      </button>
    </th>
  );

  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 bg-card">
        <tr className="border-b text-left text-xs text-muted-foreground">
          {header("site", "Sitio", false)}
          {header("drawn", "Muestreadas")}
          {header("reviewed", "Revisadas")}
          {header("correct", "Correctos")}
        </tr>
      </thead>
      <tbody>
        {sorted.map((s) => (
          <tr key={s.siteName ?? "__sin_sitio__"} className="border-b last:border-0">
            {/* Labelled, not dropped: at least one deployment in the data
                carries no site name. */}
            <td className="py-1">
              {s.siteName ?? (
                <span className="italic text-muted-foreground">Sitio sin nombre</span>
              )}
            </td>
            <td className="py-1 text-right tabular-nums">{s.drawn}</td>
            <td className="py-1 text-right tabular-nums">{s.reviewed}</td>
            <td
              className={`py-1 text-right tabular-nums ${
                showCorrect && (s.correct ?? 0) > 0 ? "font-medium text-emerald-800" : ""
              }`}
            >
              {showCorrect && s.correct !== null ? s.correct : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
