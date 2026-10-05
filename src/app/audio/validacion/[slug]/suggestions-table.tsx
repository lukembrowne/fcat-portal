"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { SortIcon } from "@/components/sort-icon";

import { ClipPlayer } from "./clip-player";

/** One suggestion as the table renders it; names are resolved on the server. */
export interface SuggestionRow {
  reviewId: number;
  sampleId: number;
  sourceSpecies: string;
  sourceDisplayName: string;
  sourceSlug: string;
  siteName: string | null;
  recordedAt: string | null;
  reviewerLabel: string;
  reviewerEmail: string;
  /** ISO timestamp. */
  reviewedAt: string;
}

export type SuggestionSortKey = "source" | "site" | "recordedAt" | "reviewer" | "reviewedAt";
type SortDir = "asc" | "desc";

/**
 * Pure sort so the ordering is testable without rendering. Missing values
 * (no site, no timestamp in the filename) sort last in both directions, and
 * ties break on the review id so equal rows cannot reshuffle between renders.
 */
export function sortSuggestions(
  rows: SuggestionRow[],
  key: SuggestionSortKey,
  dir: SortDir
): SuggestionRow[] {
  const sign = dir === "asc" ? 1 : -1;
  const value = (row: SuggestionRow): string | null => {
    switch (key) {
      case "source":
        return row.sourceDisplayName.toLowerCase();
      case "site":
        return row.siteName;
      case "recordedAt":
        // "YYYY-MM-DD HH:mm:ss" orders correctly as a string.
        return row.recordedAt;
      case "reviewer":
        return row.reviewerLabel.toLowerCase();
      case "reviewedAt":
        return row.reviewedAt;
    }
  };
  return [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null && vb !== null) return 1;
    if (vb === null && va !== null) return -1;
    if (va !== null && vb !== null) {
      const cmp = va.localeCompare(vb);
      if (cmp !== 0) return cmp * sign;
    }
    return a.reviewId - b.reviewId;
  });
}

function formatReviewedAt(iso: string): string {
  // Ecuador wall-clock date, explicitly: rendered on the server and again on
  // the client, and an implicit zone would disagree between the two.
  return new Date(iso).toLocaleDateString("es-EC", {
    timeZone: "America/Guayaquil",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export function SuggestionsTable({ rows }: { rows: SuggestionRow[] }) {
  // Newest first: a suggestion is most useful to whoever is deciding what to
  // validate next, and the fresh ones are what they have not heard yet.
  const [sortKey, setSortKey] = useState<SuggestionSortKey>("reviewedAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [openId, setOpenId] = useState<number | null>(null);

  const sorted = useMemo(
    () => sortSuggestions(rows, sortKey, sortDir),
    [rows, sortKey, sortDir]
  );

  const toggle = (key: SuggestionSortKey) => {
    if (key === sortKey) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(key === "reviewedAt" || key === "recordedAt" ? "desc" : "asc");
    }
  };

  const header = (key: SuggestionSortKey, label: string) => (
    <th className="whitespace-nowrap px-2 py-1.5 text-left font-medium">
      <button
        type="button"
        onClick={() => toggle(key)}
        className="inline-flex items-center gap-1 hover:text-foreground"
      >
        {label}
        <SortIcon direction={sortKey === key ? sortDir : false} />
      </button>
    </th>
  );

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full min-w-[40rem] text-sm">
        <thead className="border-b bg-muted/50 text-[11px] text-muted-foreground">
          <tr>
            {header("source", "Validando")}
            {header("site", "Sitio")}
            {header("recordedAt", "Grabación")}
            {header("reviewer", "Revisor")}
            {header("reviewedAt", "Revisado")}
            <th className="px-2 py-1.5 text-left font-medium">Escuchar</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={row.reviewId} className="border-b align-top last:border-0">
              <td className="px-2 py-2">
                <Link
                  href={`/audio/validacion/${row.sourceSlug}`}
                  className="hover:underline"
                >
                  {row.sourceDisplayName}
                </Link>
                <div className="text-[11px] italic text-muted-foreground">
                  {row.sourceSpecies}
                </div>
              </td>
              <td className="whitespace-nowrap px-2 py-2">
                {row.siteName ?? (
                  <span className="italic text-muted-foreground">Sitio sin nombre</span>
                )}
              </td>
              <td className="whitespace-nowrap px-2 py-2 tabular-nums">
                {row.recordedAt ?? "—"}
              </td>
              <td className="px-2 py-2" title={row.reviewerEmail}>
                {row.reviewerLabel}
              </td>
              <td className="whitespace-nowrap px-2 py-2 tabular-nums">
                {formatReviewedAt(row.reviewedAt)}
              </td>
              <td className="px-2 py-2">
                <ClipPlayer
                  sampleId={row.sampleId}
                  open={openId === row.reviewId}
                  onOpen={() => setOpenId(row.reviewId)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
