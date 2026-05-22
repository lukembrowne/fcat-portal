"use client";

/**
 * Confusion matrix heatmap.
 *
 * - Renders as a semantic <table> (accessible: scope=row/col, aria-label per
 *   cell, <caption>). sklearn's ConfusionMatrixDisplay and TensorBoard both
 *   render as images with no text alternative — we don't.
 * - Cividis colormap (CVD-safe). Sequential, fixed [0, 1] range in normalized
 *   modes so two models compare visually.
 * - Four modes: raw counts, row-normalized (recall view), col-normalized
 *   (precision view), % of total (sklearn's `normalize='all'`).
 * - Single delegated tooltip on the grid root — not one Radix Tooltip per
 *   cell (would be ~2MB heap at 30×30).
 * - Default class sort: by test support descending (puts dominant classes
 *   top-left, makes long-tail confusion obvious).
 * - Top-N confused pairs list panel for the actionable view.
 *
 * No new dependency: recharts has no heatmap, and a 20×20 grid is cheap.
 */

import { useMemo, useState } from "react";

type Mode = "raw" | "rowNorm" | "colNorm" | "totalNorm";
type SortMode = "support" | "alpha";

const CIVIDIS_10: readonly string[] = [
  "#00224e",
  "#123570",
  "#3b496c",
  "#575c6e",
  "#707173",
  "#8a8678",
  "#a59c74",
  "#c3b369",
  "#e1cc55",
  "#fde737",
];

function colorFor(value: number, max: number): string {
  if (max <= 0) return CIVIDIS_10[0];
  const t = Math.max(0, Math.min(1, value / max));
  const idx = Math.max(0, Math.min(9, Math.floor(t * 9)));
  return CIVIDIS_10[idx];
}

function modeLabel(mode: Mode): string {
  switch (mode) {
    case "raw":
      return "Crudo";
    case "rowNorm":
      return "Por fila (recall)";
    case "colNorm":
      return "Por columna (precisión)";
    case "totalNorm":
      return "% del total";
  }
}

function rowSums(matrix: ReadonlyArray<ReadonlyArray<number>>): number[] {
  return matrix.map((r) => r.reduce((a, b) => a + b, 0));
}

function colSums(matrix: ReadonlyArray<ReadonlyArray<number>>): number[] {
  if (matrix.length === 0) return [];
  const N = matrix[0].length;
  const out = new Array(N).fill(0);
  for (let i = 0; i < matrix.length; i++) {
    for (let j = 0; j < N; j++) out[j] += matrix[i][j];
  }
  return out;
}

function total(matrix: ReadonlyArray<ReadonlyArray<number>>): number {
  let t = 0;
  for (const r of matrix) for (const v of r) t += v;
  return t;
}

export function ConfusionMatrixHeatmap({
  classes,
  matrix,
  supportByClass,
}: {
  classes: readonly string[];
  matrix: ReadonlyArray<ReadonlyArray<number>>;
  /** Test support per class — used for the default support-descending sort. */
  supportByClass?: ReadonlyMap<string, number>;
}) {
  const [mode, setMode] = useState<Mode>("rowNorm");
  const [sortMode, setSortMode] = useState<SortMode>("support");

  // Compute the class order based on sortMode. The displayed matrix is a
  // permutation of the raw one.
  const order = useMemo(() => {
    const idxs = classes.map((_, i) => i);
    if (sortMode === "alpha") {
      idxs.sort((a, b) => classes[a].localeCompare(classes[b]));
    } else {
      // by support desc; fallback to alphabetical for ties
      idxs.sort((a, b) => {
        const sa = supportByClass?.get(classes[a]) ?? 0;
        const sb = supportByClass?.get(classes[b]) ?? 0;
        if (sa !== sb) return sb - sa;
        return classes[a].localeCompare(classes[b]);
      });
    }
    return idxs;
  }, [classes, sortMode, supportByClass]);

  const orderedClasses = useMemo(
    () => order.map((i) => classes[i]),
    [order, classes],
  );

  const orderedMatrix = useMemo(
    () =>
      order.map((i) => order.map((j) => matrix[i][j])) as number[][],
    [order, matrix],
  );

  const rSums = useMemo(() => rowSums(orderedMatrix), [orderedMatrix]);
  const cSums = useMemo(() => colSums(orderedMatrix), [orderedMatrix]);
  const grandTotal = useMemo(() => total(orderedMatrix), [orderedMatrix]);

  // Normalized display values.
  const displayMatrix = useMemo(() => {
    const N = orderedMatrix.length;
    const out: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const raw = orderedMatrix[i][j];
        switch (mode) {
          case "raw":
            out[i][j] = raw;
            break;
          case "rowNorm":
            out[i][j] = rSums[i] > 0 ? raw / rSums[i] : 0;
            break;
          case "colNorm":
            out[i][j] = cSums[j] > 0 ? raw / cSums[j] : 0;
            break;
          case "totalNorm":
            out[i][j] = grandTotal > 0 ? raw / grandTotal : 0;
            break;
        }
      }
    }
    return out;
  }, [orderedMatrix, mode, rSums, cSums, grandTotal]);

  const maxForScale =
    mode === "raw"
      ? Math.max(...displayMatrix.flat().map((v) => v))
      : 1;

  // Top-N confused pairs (off-diagonal cells sorted desc by raw count).
  const topConfused = useMemo(() => {
    const pairs: Array<{
      trueClass: string;
      predClass: string;
      count: number;
      rowPct: number;
    }> = [];
    for (let i = 0; i < orderedMatrix.length; i++) {
      for (let j = 0; j < orderedMatrix[i].length; j++) {
        if (i === j) continue;
        if (orderedMatrix[i][j] === 0) continue;
        pairs.push({
          trueClass: orderedClasses[i],
          predClass: orderedClasses[j],
          count: orderedMatrix[i][j],
          rowPct: rSums[i] > 0 ? orderedMatrix[i][j] / rSums[i] : 0,
        });
      }
    }
    pairs.sort((a, b) => b.count - a.count);
    return pairs.slice(0, 10);
  }, [orderedMatrix, orderedClasses, rSums]);

  function formatDisplay(value: number): string {
    if (mode === "raw") return String(value);
    if (value === 0) return "0%";
    return (value * 100).toFixed(value >= 0.1 ? 0 : 1) + "%";
  }

  const dominantPair = topConfused[0];
  const caption = `Matriz de confusión ${orderedMatrix.length}×${orderedMatrix.length}, modo ${modeLabel(mode)}${dominantPair ? `. Confusión dominante: ${dominantPair.trueClass} → ${dominantPair.predClass} (${dominantPair.count}).` : ""}`;

  function downloadCsv() {
    const lines = [
      [""].concat(orderedClasses).join(","),
      ...orderedMatrix.map((row, i) =>
        [orderedClasses[i]]
          .concat(row.map((v) => String(v)))
          .join(","),
      ),
    ];
    const blob = new Blob([lines.join("\n") + "\n"], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `confusion-matrix-${orderedMatrix.length}x${orderedMatrix.length}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-3">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded border bg-card" role="group">
          {(
            [
              ["raw", "Crudo"],
              ["rowNorm", "Por fila"],
              ["colNorm", "Por col."],
              ["totalNorm", "% total"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={
                "px-2.5 py-1 text-xs font-medium " +
                (mode === m
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted")
              }
              aria-pressed={mode === m}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="inline-flex rounded border bg-card" role="group">
          {(
            [
              ["support", "Por soporte"],
              ["alpha", "Alfabético"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              onClick={() => setSortMode(m)}
              className={
                "px-2.5 py-1 text-xs font-medium " +
                (sortMode === m
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted")
              }
              aria-pressed={sortMode === m}
            >
              {label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={downloadCsv}
          className="ml-auto rounded border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted"
        >
          Descargar CSV
        </button>
      </div>

      {/* Heatmap + Top-N panel */}
      <div className="grid gap-4 lg:grid-cols-[1fr_240px]">
        <div className="overflow-x-auto border rounded bg-background">
          <table
            role="grid"
            className="text-[10px] border-separate"
            style={{ borderSpacing: 0 }}
          >
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr>
                <th scope="col" className="p-1"></th>
                {orderedClasses.map((cls) => (
                  <th
                    key={cls}
                    scope="col"
                    className="p-1 align-bottom"
                    style={{
                      writingMode: "vertical-rl",
                      transform: "rotate(180deg)",
                      minWidth: 24,
                      maxWidth: 24,
                    }}
                    title={cls}
                  >
                    <span className="font-mono">{cls}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {orderedMatrix.map((row, i) => (
                <tr key={orderedClasses[i]}>
                  <th
                    scope="row"
                    className="px-2 py-1 text-right font-mono whitespace-nowrap"
                    title={orderedClasses[i]}
                  >
                    {orderedClasses[i]}
                  </th>
                  {row.map((v, j) => {
                    const isDiag = i === j;
                    const displayVal = displayMatrix[i][j];
                    const raw = orderedMatrix[i][j];
                    const rowPct =
                      rSums[i] > 0 ? raw / rSums[i] : 0;
                    const colPct =
                      cSums[j] > 0 ? raw / cSums[j] : 0;
                    const totalPct =
                      grandTotal > 0 ? raw / grandTotal : 0;
                    const bg = colorFor(displayVal, maxForScale);
                    return (
                      <td
                        key={j}
                        className={
                          "text-center font-mono " +
                          (isDiag ? "ring-1 ring-foreground/30" : "")
                        }
                        style={{
                          backgroundColor: bg,
                          color: displayVal > maxForScale * 0.55 ? "#1a1a1a" : "#f1f5f9",
                          minWidth: 24,
                          maxWidth: 24,
                          height: 24,
                          padding: 0,
                          fontWeight: isDiag ? 700 : 400,
                        }}
                        aria-label={`Verdadero ${orderedClasses[i]}, predicho ${orderedClasses[j]}: ${raw} (fila ${(rowPct * 100).toFixed(1)}%, columna ${(colPct * 100).toFixed(1)}%, total ${(totalPct * 100).toFixed(2)}%)`}
                        title={`V: ${orderedClasses[i]} · P: ${orderedClasses[j]}\nconteo: ${raw} · fila: ${(rowPct * 100).toFixed(1)}% · col: ${(colPct * 100).toFixed(1)}% · total: ${(totalPct * 100).toFixed(2)}%`}
                      >
                        {raw > 0 ? formatDisplay(displayVal) : ""}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {topConfused.length > 0 && (
          <aside className="rounded border bg-background p-3">
            <h4 className="text-xs font-semibold mb-2">
              Pares más confundidos
            </h4>
            <ol className="space-y-1 text-xs">
              {topConfused.map((p, idx) => (
                <li
                  key={`${p.trueClass}->${p.predClass}`}
                  className="flex items-baseline gap-2"
                >
                  <span className="text-muted-foreground tabular-nums w-5">
                    {idx + 1}.
                  </span>
                  <span className="flex-1 truncate">
                    <span className="font-mono">{p.trueClass}</span>
                    {" → "}
                    <span className="font-mono">{p.predClass}</span>
                  </span>
                  <span className="font-mono tabular-nums">
                    {p.count}{" "}
                    <span className="text-muted-foreground">
                      ({(p.rowPct * 100).toFixed(0)}%)
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </aside>
        )}
      </div>
    </div>
  );
}
