"use client";

import { useMemo, useState } from "react";

import { SortIcon } from "@/components/sort-icon";

import { ClipPlayer } from "./clip-player";

/** One note as the table renders it; names are resolved on the server. */
export interface ReviewNoteRow {
  reviewId: number;
  sampleId: number;
  note: string;
  outcome: "correct" | "incorrect" | "uncertain";
  siteName: string | null;
  recordedAt: string | null;
  reviewerLabel: string;
  reviewerEmail: string;
}

export type ReviewNoteSortKey = "note" | "outcome" | "site" | "recordedAt" | "reviewer";
type SortDir = "asc" | "desc";

const OUTCOME_LABEL: Record<ReviewNoteRow["outcome"], string> = {
  correct: "correcta",
  incorrect: "incorrecta",
  uncertain: "incierta",
};

const OUTCOME_CLASS: Record<ReviewNoteRow["outcome"], string> = {
  correct: "bg-emerald-100 text-emerald-900",
  incorrect: "bg-red-100 text-red-900",
  uncertain: "bg-amber-100 text-amber-900",
};

/**
 * Pure sort so the ordering is testable without rendering. Missing values sort
 * last in both directions; ties break on the review id so equal rows cannot
 * reshuffle between renders.
 */
export function sortReviewNotes(
  rows: ReviewNoteRow[],
  key: ReviewNoteSortKey,
  dir: SortDir
): ReviewNoteRow[] {
  const sign = dir === "asc" ? 1 : -1;
  const value = (row: ReviewNoteRow): string | null => {
    switch (key) {
      case "note":
        return row.note.toLowerCase();
      case "outcome":
        return row.outcome;
      case "site":
        return row.siteName;
      case "recordedAt":
        return row.recordedAt;
      case "reviewer":
        return row.reviewerLabel.toLowerCase();
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

/** Case- and accent-insensitive match on the note text and the reviewer. */
export function filterReviewNotes(rows: ReviewNoteRow[], query: string): ReviewNoteRow[] {
  const fold = (s: string) =>
    s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const q = fold(query.trim());
  if (!q) return rows;
  return rows.filter(
    (r) => fold(r.note).includes(q) || fold(r.reviewerLabel).includes(q)
  );
}

export function ReviewNotesTable({ rows }: { rows: ReviewNoteRow[] }) {
  // Note text first, ascending: notes used as labels ("alarma", "canto") then
  // group together, which is what a reader scanning call types wants.
  const [sortKey, setSortKey] = useState<ReviewNoteSortKey>("note");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);

  const shown = useMemo(
    () => sortReviewNotes(filterReviewNotes(rows, query), sortKey, sortDir),
    [rows, query, sortKey, sortDir]
  );

  const toggle = (key: ReviewNoteSortKey) => {
    if (key === sortKey) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(key === "recordedAt" ? "desc" : "asc");
    }
  };

  const header = (key: ReviewNoteSortKey, label: string) => (
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
    <div className="space-y-2">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filtrar notas (p. ej. «alarma»)"
        className="w-full max-w-xs rounded-md border bg-background px-2 py-1 text-sm"
      />
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full min-w-[44rem] text-sm">
          <thead className="border-b bg-muted/50 text-[11px] text-muted-foreground">
            <tr>
              {header("note", "Nota")}
              {header("outcome", "Respuesta")}
              {header("site", "Sitio")}
              {header("recordedAt", "Grabación")}
              {header("reviewer", "Revisor")}
              <th className="px-2 py-1.5 text-left font-medium">Escuchar</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-2 py-3 text-sm text-muted-foreground">
                  Ninguna nota coincide con «{query.trim()}».
                </td>
              </tr>
            ) : (
              shown.map((row) => (
                <tr key={row.reviewId} className="border-b align-top last:border-0">
                  <td className="px-2 py-2">
                    {/* Width on an inner block: a table cell ignores min-width
                        under auto layout and collapses to one word per line. */}
                    <div className="w-[14rem] whitespace-pre-wrap break-words">
                      {row.note}
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[11px] ${OUTCOME_CLASS[row.outcome]}`}
                    >
                      {OUTCOME_LABEL[row.outcome]}
                    </span>
                  </td>
                  <td className="min-w-[8rem] px-2 py-2">
                    {row.siteName ?? (
                      <span className="italic text-muted-foreground">Sitio sin nombre</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 tabular-nums">
                    {row.recordedAt ?? "—"}
                  </td>
                  <td className="px-2 py-2 [overflow-wrap:anywhere]" title={row.reviewerEmail}>
                    {row.reviewerLabel}
                  </td>
                  <td className="px-2 py-2">
                    <ClipPlayer
                      sampleId={row.sampleId}
                      open={openId === row.reviewId}
                      onOpen={() => setOpenId(row.reviewId)}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
