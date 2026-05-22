"use client";

/**
 * Comparison table for registered camera-trap classifier models.
 *
 * - One row per model.
 * - Fixed columns (Versión, Dataset, Top-1, F1 macro, Umbral, Activo, Fecha)
 *   plus one dynamic column per species in the UNION across all models.
 * - Species column accessor switches based on `metricMode` (F1 / Precisión /
 *   Recall); column id is stable so sort/visibility state survives.
 * - Nulls/undefined always sink to the bottom regardless of sort direction
 *   via tanstack's built-in `sortUndefined: "last"`.
 * - Sticky left column (Versión) using `position: sticky`.
 * - Column visibility (species only — critical columns are pinned non-hideable)
 *   persists in localStorage.
 * - Per-row expand chevron → ModelDetailPanel (heatmap + per-class table +
 *   hyperparams).
 */

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ExpandedState,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import { ChevronDown, ChevronRight, Eye, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SortIcon } from "@/components/sort-icon";
import { deleteModel, registerModelFromDir, setActiveModel } from "./actions";
import { ModelDetailPanel } from "./model-detail-panel";

export interface ClassMetricRow {
  modelId: number;
  className: string;
  precisionValue: number | null;
  recall: number | null;
  f1: number | null;
  support: number;
  trainCount: number | null;
}

export interface ModelRow {
  id: number;
  version: string;
  modelDir: string;
  confidenceThreshold: number;
  active: boolean;
  createdAt: string;
  createdBy: string;
  trainingDatasetVersion: string | null;
  top1Accuracy: number | null;
  macroF1: number | null;
  hasConfusionMatrix: boolean;
  classMetrics: ClassMetricRow[];
  /** Raw metrics.json string — parsed in the drill-down for hyperparameters. */
  metricsJson: string;
}

type MetricMode = "f1" | "precision" | "recall";

interface IndexedModelRow extends ModelRow {
  /** Indexed lookup for the species column accessor. */
  byClass: Map<string, ClassMetricRow>;
}

const VISIBILITY_KEY = "ct-models-hidden-classes";
const METRIC_MODE_KEY = "ct-models-metric-mode";

const FIXED_COL_IDS = new Set([
  "expander",
  "version",
  "dataset",
  "top1",
  "macroF1",
  "threshold",
  "active",
  "createdAt",
  "actions",
]);

function readMetricMode(): MetricMode {
  if (typeof window === "undefined") return "f1";
  try {
    const stored = window.localStorage.getItem(METRIC_MODE_KEY);
    if (stored === "precision" || stored === "recall") return stored;
  } catch {
    /* localStorage disabled */
  }
  return "f1";
}

function readHiddenClasses(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(VISIBILITY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, boolean>;
    return parsed;
  } catch {
    return {};
  }
}

function pickValue(
  row: ClassMetricRow | undefined,
  mode: MetricMode,
): number | undefined {
  if (!row) return undefined;
  const v =
    mode === "f1" ? row.f1 : mode === "precision" ? row.precisionValue : row.recall;
  return v == null ? undefined : v;
}

function formatPct(v: number): string {
  return (v * 100).toFixed(1) + "%";
}

function CIVIDIS_STOPS(): readonly string[] {
  // 10-stop Cividis approximation (CVD-safe). Indexed by Math.floor(v * 9).
  return [
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
}

function tintForValue(v: number): string {
  const stops = CIVIDIS_STOPS();
  const idx = Math.max(0, Math.min(9, Math.floor(v * 9)));
  return stops[idx];
}

export function ComparisonTable({
  rows,
  allClassesUnion,
}: {
  rows: ModelRow[];
  allClassesUnion: string[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [metricMode, setMetricMode] = useState<MetricMode>(() =>
    readMetricMode(),
  );
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(
    () => readHiddenClasses(),
  );
  const [sorting, setSorting] = useState<SortingState>([]);
  const [expanded, setExpanded] = useState<ExpandedState>({});

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(METRIC_MODE_KEY, metricMode);
    } catch {
      /* ignore */
    }
  }, [metricMode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        VISIBILITY_KEY,
        JSON.stringify(columnVisibility),
      );
    } catch {
      /* ignore */
    }
  }, [columnVisibility]);

  // Build indexed rows once so column accessors don't pay an O(N) lookup.
  const indexed: IndexedModelRow[] = useMemo(
    () =>
      rows.map((m) => ({
        ...m,
        byClass: new Map(m.classMetrics.map((c) => [c.className, c])),
      })),
    [rows],
  );

  const handleActivate = (modelId: number) => {
    setError(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("modelId", String(modelId));
      const res = await setActiveModel(formData);
      if (res.success) router.refresh();
      else setError(res.error);
    });
  };

  const handleDelete = (modelId: number, version: string) => {
    if (
      !confirm(
        `¿Borrar el modelo ${version}? Esta acción no borra los archivos en disco.`,
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("modelId", String(modelId));
      const res = await deleteModel(formData);
      if (res.success) router.refresh();
      else setError(res.error);
    });
  };

  const handleReimport = (modelDir: string) => {
    if (
      !confirm(
        `¿Re-importar este modelo desde ${modelDir}? Necesita estar en formato v2.`,
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const formData = new FormData();
      // registerModelFromDir expects a leaf dir name relative to data/models/
      const dirName = modelDir.split("/").filter(Boolean).slice(-1)[0] ?? "";
      formData.set("dirName", dirName);
      formData.set("allowUntracked", "on");
      const res = await registerModelFromDir(formData);
      if (res.success) router.refresh();
      else setError(res.error);
    });
  };

  const fixedColumns: ColumnDef<IndexedModelRow>[] = useMemo(
    () => [
      {
        id: "expander",
        header: () => null,
        cell: ({ row }) =>
          row.original.hasConfusionMatrix ? (
            <button
              type="button"
              aria-label={row.getIsExpanded() ? "Cerrar detalle" : "Abrir detalle"}
              onClick={(e) => {
                e.stopPropagation();
                row.toggleExpanded();
              }}
              className="text-muted-foreground hover:text-foreground"
            >
              {row.getIsExpanded() ? (
                <ChevronDown size={16} />
              ) : (
                <ChevronRight size={16} />
              )}
            </button>
          ) : null,
        enableSorting: false,
        enableHiding: false,
        size: 32,
      },
      {
        id: "version",
        header: "Versión",
        accessorKey: "version",
        enableHiding: false,
        cell: ({ row }) => (
          <span className="font-mono text-xs">
            {row.original.version}
            {!row.original.hasConfusionMatrix && (
              <Badge
                variant="outline"
                className="ml-2 text-[10px] uppercase tracking-wide"
                title="Modelo registrado antes del contrato v2; re-importar para comparar."
              >
                heredado
              </Badge>
            )}
          </span>
        ),
      },
      {
        id: "dataset",
        header: "Dataset",
        accessorFn: (r) => r.trainingDatasetVersion ?? "",
        enableHiding: false,
        cell: ({ row }) =>
          row.original.trainingDatasetVersion ? (
            <span className="font-mono text-xs">
              {row.original.trainingDatasetVersion}
            </span>
          ) : (
            <span className="italic text-muted-foreground text-xs">
              no registrado
            </span>
          ),
      },
      {
        id: "top1",
        header: "Top-1",
        accessorFn: (r) => r.top1Accuracy ?? undefined,
        sortUndefined: "last",
        sortDescFirst: true,
        enableHiding: false,
        cell: ({ row }) =>
          row.original.top1Accuracy != null ? (
            <span className="font-mono">
              {formatPct(row.original.top1Accuracy)}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "macroF1",
        header: "F1 macro",
        accessorFn: (r) => r.macroF1 ?? undefined,
        sortUndefined: "last",
        sortDescFirst: true,
        enableHiding: false,
        cell: ({ row }) =>
          row.original.macroF1 != null ? (
            <span className="font-mono">{row.original.macroF1.toFixed(3)}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "threshold",
        header: "Umbral",
        accessorKey: "confidenceThreshold",
        cell: ({ row }) => (
          <span className="font-mono text-xs">
            {row.original.confidenceThreshold.toFixed(2)}
          </span>
        ),
      },
      {
        id: "active",
        header: "Activo",
        accessorFn: (r) => (r.active ? 1 : 0),
        enableHiding: false,
        sortDescFirst: true,
        cell: ({ row }) =>
          row.original.active ? (
            <Badge className="bg-green-600">Activo</Badge>
          ) : (
            <Badge variant="outline">Inactivo</Badge>
          ),
      },
      {
        id: "createdAt",
        header: "Fecha",
        accessorKey: "createdAt",
        enableHiding: false,
        cell: ({ row }) => (
          <span className="text-muted-foreground text-xs whitespace-nowrap">
            {new Date(row.original.createdAt).toLocaleDateString("es-EC")}
          </span>
        ),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        enableHiding: false,
        cell: ({ row }) => (
          <div className="flex justify-end gap-1 whitespace-nowrap">
            {row.original.hasConfusionMatrix
              ? null
              : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={isPending}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleReimport(row.original.modelDir);
                    }}
                  >
                    <RefreshCw size={14} className="mr-1" /> Re-importar
                  </Button>
                )}
            {!row.original.active && (
              <Button
                size="sm"
                variant="outline"
                disabled={isPending}
                onClick={(e) => {
                  e.stopPropagation();
                  handleActivate(row.original.id);
                }}
              >
                Activar
              </Button>
            )}
            {!row.original.active && (
              <Button
                size="sm"
                variant="ghost"
                disabled={isPending}
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete(row.original.id, row.original.version);
                }}
              >
                Borrar
              </Button>
            )}
          </div>
        ),
      },
    ],
    // handleActivate / handleDelete / handleReimport close over isPending,
    // which only changes during transitions. We re-create on each render —
    // cheap, and avoids stale closures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isPending],
  );

  const speciesColumns: ColumnDef<IndexedModelRow>[] = useMemo(
    () =>
      allClassesUnion.map((cls) => ({
        id: `sp__${cls}`,
        // Stable column id — only accessorFn closes over metricMode so sort
        // and visibility state survive metric toggles.
        accessorFn: (row) => pickValue(row.byClass.get(cls), metricMode),
        header: cls,
        sortUndefined: "last",
        sortDescFirst: true,
        cell: ({ row }) => {
          const c = row.original.byClass.get(cls);
          if (!c) {
            return <span className="text-muted-foreground/60">—</span>;
          }
          const v = pickValue(c, metricMode);
          if (v == null) {
            return (
              <span
                className="text-muted-foreground/60"
                title="Sin soporte de prueba"
              >
                —
              </span>
            );
          }
          const untrained = c.trainCount === 0;
          return (
            <span
              className={
                "inline-block min-w-12 text-center font-mono text-xs px-1.5 py-0.5 rounded " +
                (untrained ? "italic opacity-70" : "")
              }
              style={{
                backgroundColor: tintForValue(v),
                color: v > 0.55 ? "#1a1a1a" : "#f1f5f9",
              }}
              title={
                untrained ? "Sin imágenes de entrenamiento" : undefined
              }
            >
              {v.toFixed(2)}
            </span>
          );
        },
      })),
    [allClassesUnion, metricMode],
  );

  const columns = useMemo(
    () => [...fixedColumns, ...speciesColumns],
    [fixedColumns, speciesColumns],
  );

  const table = useReactTable({
    data: indexed,
    columns,
    state: { sorting, expanded, columnVisibility },
    onSortingChange: setSorting,
    onExpandedChange: setExpanded,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getRowCanExpand: (row) => row.original.hasConfusionMatrix,
  });

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Todavía no hay modelos registrados.
      </p>
    );
  }

  const hideableColumns = table
    .getAllLeafColumns()
    .filter((col) => !FIXED_COL_IDS.has(col.id));

  return (
    <div className="space-y-3">
      {/* Controls row: metric mode selector + column visibility menu */}
      <div className="flex flex-wrap items-center gap-3">
        <div
          className="inline-flex rounded border bg-card"
          role="group"
          aria-label="Métrica por especie"
        >
          {(
            [
              ["f1", "F1"],
              ["precision", "Precisión"],
              ["recall", "Recall"],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              onClick={() => setMetricMode(mode)}
              className={
                "px-3 py-1 text-xs font-medium transition-colors " +
                (metricMode === mode
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted")
              }
              aria-pressed={metricMode === mode}
            >
              {label}
            </button>
          ))}
        </div>

        <ColumnVisibilityMenu
          columns={hideableColumns.map((c) => ({
            id: c.id,
            label: c.id.replace(/^sp__/, ""),
            isVisible: c.getIsVisible(),
            toggle: () => c.toggleVisibility(),
          }))}
        />

        <span className="text-xs text-muted-foreground ml-auto">
          {rows.length} modelo{rows.length === 1 ? "" : "s"} ·{" "}
          {allClassesUnion.length} especie
          {allClassesUnion.length === 1 ? "" : "s"}
        </span>
      </div>

      {error && (
        <div className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div
        className="overflow-x-auto border rounded-lg"
        style={{ contain: "paint" }}
      >
        <table
          className="w-full text-sm border-separate"
          style={{ borderSpacing: 0 }}
        >
          <thead className="bg-muted/50">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h, idx) => {
                  const isSticky = idx === 0 || h.column.id === "version";
                  const isSpecies = h.column.id.startsWith("sp__");
                  return (
                    <th
                      key={h.id}
                      className={
                        "px-3 py-2 text-left font-semibold border-b align-bottom " +
                        (isSpecies ? "text-right" : "") +
                        (isSticky
                          ? " sticky left-0 z-10 bg-muted/50"
                          : "")
                      }
                      style={
                        isSpecies
                          ? { writingMode: "vertical-rl", transform: "rotate(180deg)", minWidth: 32 }
                          : undefined
                      }
                    >
                      {h.column.getCanSort() ? (
                        <button
                          type="button"
                          onClick={h.column.getToggleSortingHandler()}
                          className="inline-flex items-center gap-1"
                          aria-label={`Ordenar por ${h.column.id}`}
                        >
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          <SortIcon direction={h.column.getIsSorted()} />
                        </button>
                      ) : (
                        flexRender(h.column.columnDef.header, h.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <RowFragment
                key={row.id}
                row={row}
                expanded={row.getIsExpanded()}
                modelMetricsJson={row.original.metricsJson}
                modelId={row.original.id}
                hasConfusionMatrix={row.original.hasConfusionMatrix}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type Row = ReturnType<
  ReturnType<typeof useReactTable<IndexedModelRow>>["getRowModel"]
>["rows"][number];

function RowFragment({
  row,
  expanded,
  modelMetricsJson,
  modelId,
  hasConfusionMatrix,
}: {
  row: Row;
  expanded: boolean;
  modelMetricsJson: string;
  modelId: number;
  hasConfusionMatrix: boolean;
}) {
  const visibleLeafCount = row.getVisibleCells().length;
  return (
    <>
      <tr className="border-t hover:bg-muted/20">
        {row.getVisibleCells().map((cell, idx) => {
          const isSticky = idx === 0 || cell.column.id === "version";
          return (
            <td
              key={cell.id}
              className={
                "px-3 py-2 border-b " +
                (cell.column.id.startsWith("sp__") ? "text-right" : "") +
                (isSticky ? " sticky left-0 z-[1] bg-background" : "")
              }
            >
              {flexRender(cell.column.columnDef.cell, cell.getContext())}
            </td>
          );
        })}
      </tr>
      {expanded && hasConfusionMatrix && (
        <tr>
          <td
            colSpan={visibleLeafCount}
            className="bg-muted/20 p-4 border-b"
          >
            <ModelDetailPanel
              modelId={modelId}
              classMetrics={row.original.classMetrics}
              metricsJson={modelMetricsJson}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function ColumnVisibilityMenu({
  columns,
}: {
  columns: Array<{
    id: string;
    label: string;
    isVisible: boolean;
    toggle: () => void;
  }>;
}) {
  const [open, setOpen] = useState(false);
  if (columns.length === 0) return null;
  const visibleCount = columns.filter((c) => c.isVisible).length;
  return (
    <div className="relative">
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <Eye size={14} className="mr-1.5" />
        Columnas ({visibleCount}/{columns.length})
      </Button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 max-h-80 w-56 overflow-y-auto rounded border bg-popover p-2 shadow-lg">
          {columns.map((c) => (
            <label
              key={c.id}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted"
            >
              <input
                type="checkbox"
                checked={c.isVisible}
                onChange={c.toggle}
              />
              <span className="font-mono truncate" title={c.label}>
                {c.label}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
