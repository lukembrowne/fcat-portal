"use client";

import { useMemo, useState } from "react";

import type { Disagreement } from "@/app/audio/validacion/actions";
import { SortIcon } from "@/components/sort-icon";

type SortKey = "confidence" | "site" | "habitat" | "answers";
type SortDir = "asc" | "desc";

const OUTCOME_LABEL: Record<string, string> = {
  correct: "correcta",
  incorrect: "incorrecta",
  uncertain: "incierta",
};

const OUTCOME_CLASS: Record<string, string> = {
  correct: "bg-emerald-100 text-emerald-900",
  incorrect: "bg-red-100 text-red-900",
  uncertain: "bg-amber-100 text-amber-900",
};

function reviewerLabel(a: { email: string; name: string | null }): string {
  return a.name?.trim() || a.email;
}

/**
 * Pure sort so the ordering is testable without rendering.
 *
 * Ties break on `sampleId` so pagination and re-renders cannot reshuffle rows
 * that compare equal.
 */
export function sortDisagreements(
  rows: Disagreement[],
  key: SortKey,
  dir: SortDir
): Disagreement[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    let cmp = 0;
    switch (key) {
      case "confidence":
        cmp = a.confidence - b.confidence;
        break;
      case "site":
        cmp = (a.siteName ?? "").localeCompare(b.siteName ?? "");
        break;
      case "habitat":
        cmp = (a.habitat ?? "").localeCompare(b.habitat ?? "");
        break;
      case "answers":
        cmp = a.answers.length - b.answers.length;
        break;
    }
    return cmp !== 0 ? cmp * sign : a.sampleId - b.sampleId;
  });
}

export function DisagreementTable({ rows }: { rows: Disagreement[] }) {
  // High confidence first: those are the clips a threshold would retain, so a
  // disagreement there matters more than one at 0.15.
  const [sortKey, setSortKey] = useState<SortKey>("confidence");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [openId, setOpenId] = useState<number | null>(null);

  const sorted = useMemo(
    () => sortDisagreements(rows, sortKey, sortDir),
    [rows, sortKey, sortDir]
  );

  const toggle = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const header = (key: SortKey, label: string, align = "left") => (
    <th className={`py-1.5 px-2 font-medium text-${align}`}>
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

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No hay desacuerdos: todos los revisores coinciden en cada grabación
        revisada en común.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="border-b bg-muted/50 text-[11px] text-muted-foreground">
          <tr>
            {header("confidence", "Confianza")}
            {header("site", "Sitio")}
            {header("habitat", "Hábitat")}
            {header("answers", "Respuestas")}
            <th className="px-2 py-1.5 font-medium">Escuchar</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={row.sampleId} className="border-b align-top last:border-0">
              <td className="px-2 py-2 tabular-nums">{row.confidence.toFixed(3)}</td>
              <td className="px-2 py-2">{row.siteName ?? "—"}</td>
              <td className="px-2 py-2">{row.habitat ?? "—"}</td>
              <td className="px-2 py-2">
                <div className="flex flex-wrap gap-1">
                  {row.answers.map((a) => (
                    <span
                      key={a.email}
                      className={`rounded px-1.5 py-0.5 text-[11px] ${
                        OUTCOME_CLASS[a.outcome] ?? ""
                      }`}
                      title={a.email}
                    >
                      {reviewerLabel(a)}: {OUTCOME_LABEL[a.outcome] ?? a.outcome}
                    </span>
                  ))}
                </div>
              </td>
              <td className="px-2 py-2">
                {openId === row.sampleId ? (
                  <div className="space-y-1">
                    <audio
                      controls
                      autoPlay
                      className="h-8 w-56"
                      src={`/api/audio/validation-clip?sample=${row.sampleId}`}
                    />
                    {/* Matches the review client: the spectrogram is a
                        server-rendered PNG from a dynamic route, which
                        next/image cannot optimize. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/audio/validation-spectrogram?sample=${row.sampleId}`}
                      alt="Espectrograma"
                      className="h-20 w-56 rounded border object-cover"
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setOpenId(row.sampleId)}
                    className="rounded border px-2 py-1 text-[11px] hover:bg-muted"
                  >
                    Reproducir
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
