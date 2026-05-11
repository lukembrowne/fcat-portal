"use client";

import { useState, useMemo, useCallback, useTransition, useEffect, Fragment } from "react";
import { useRouter } from "next/navigation";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
  type RowSelectionState,
} from "@tanstack/react-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { StatusBadge } from "@/components/status-badge";
import { SortIcon } from "@/components/sort-icon";
import {
  Search,
  RefreshCw,
  Loader2,
  AudioLines,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useRowRangeSelection } from "@/hooks/use-row-range-selection";
import { GroupSelectAllCheckbox } from "@/components/deployments/group-select-all-checkbox";
import { enqueueAudioSyncJob } from "./drive-actions";
import type { AudioDeploymentRow, AudioProject } from "./actions";
import type { AudioProjectGroup } from "./page";
import { AudioDeploymentRowActions } from "./audio-deployment-row-actions";

interface AudioDeploymentsShellProps {
  groups: AudioProjectGroup[];
  deployments: AudioDeploymentRow[];
  counts: {
    sinEscanear: number;
    escaneados: number;
    procesando: number;
    porRevisar: number;
    revisados: number;
  };
  distinctProjects: AudioProject[];
  isEditor: boolean;
  /** ISO string of the last successful audio Drive sync, or null. */
  lastSyncAt: string | null;
}

export function AudioDeploymentsShell({
  groups,
  deployments: initialDeployments,
  counts,
  distinctProjects,
  isEditor,
  lastSyncAt: initialLastSyncAt,
}: AudioDeploymentsShellProps) {
  const router = useRouter();
  const [sorting, setSorting] = useState<SortingState>([
    { id: "name", desc: false },
  ]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  // Shift+click range selection across the (filter-, group-, and collapse-aware)
  // visible row order. Shared hook keeps refs internally so the cell renderer
  // doesn't re-memo on every selection change.
  const rangeSelection = useRowRangeSelection<AudioDeploymentRow>(setRowSelection);
  const [syncing, startSync] = useTransition();
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set()
  );
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(initialLastSyncAt);
  // Tick every 30s so the relative "hace X" label stays fresh without a refresh.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNowTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const toggleGroup = useCallback((label: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
      }
      return next;
    });
  }, []);

  const columns = useMemo<ColumnDef<AudioDeploymentRow>[]>(
    () => [
      {
        id: "select",
        header: ({ table }) => (
          <Checkbox
            checked={
              table.getIsAllPageRowsSelected() ||
              (table.getIsSomePageRowsSelected() && "indeterminate")
            }
            onCheckedChange={(value) =>
              table.toggleAllPageRowsSelected(!!value)
            }
            aria-label="Seleccionar todo"
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            checked={row.getIsSelected()}
            onClick={rangeSelection.onCheckboxClick}
            onCheckedChange={(value) =>
              rangeSelection.handleCheckedChange(row, !!value)
            }
            aria-label="Seleccionar fila (mantén Shift para seleccionar un rango)"
          />
        ),
        enableSorting: false,
        enableGlobalFilter: false,
      },
      {
        accessorKey: "name",
        header: "Nombre",
        cell: ({ getValue }) => (
          <span className="font-medium whitespace-normal">
            {getValue<string>()}
          </span>
        ),
      },
      {
        accessorKey: "siteName",
        header: "Sitio",
        cell: ({ getValue }) => (
          <span className="whitespace-normal">
            {getValue<string | null>() || "—"}
          </span>
        ),
      },
      {
        accessorKey: "displayStatus",
        header: "Estado",
        cell: ({ row }) => {
          const d = row.original;
          const showProgress =
            d.totalDetections > 0 && d.verifiedCount + d.unverifiedCount > 0;
          return (
            <span className="inline-flex items-center gap-1">
              <StatusBadge status={d.displayStatus} type="audio-deployment" />
              {showProgress && (
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {d.verifiedCount}/{d.verifiedCount + d.unverifiedCount} revisadas
                </span>
              )}
              {d.excluded && (
                <span className="inline-flex items-center rounded-full border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                  Excluida
                </span>
              )}
            </span>
          );
        },
        enableGlobalFilter: false,
      },
      {
        accessorKey: "audioFileCount",
        header: "Archivos",
        cell: ({ getValue }) => {
          const v = getValue<number>();
          return (
            <span className="tabular-nums">
              {v > 0 ? v.toLocaleString() : "—"}
            </span>
          );
        },
        enableGlobalFilter: false,
      },
      {
        accessorKey: "totalDetections",
        header: "Detecciones",
        cell: ({ getValue }) => {
          const v = getValue<number>();
          return <span className="tabular-nums">{v > 0 ? v.toLocaleString() : "—"}</span>;
        },
        enableGlobalFilter: false,
      },
      {
        accessorKey: "totalSpecies",
        header: "Especies",
        cell: ({ getValue }) => {
          const v = getValue<number>();
          return <span className="tabular-nums">{v > 0 ? v.toLocaleString() : "—"}</span>;
        },
        enableGlobalFilter: false,
      },
      {
        id: "dates",
        header: "Fechas",
        accessorFn: (row) => row.dateStart || "",
        cell: ({ row }) => {
          const { dateStart, dateEnd } = row.original;
          if (!dateStart) return "—";
          return (
            <span className="tabular-nums text-muted-foreground whitespace-nowrap">
              {dateStart}
              {dateEnd && ` — ${dateEnd}`}
            </span>
          );
        },
        enableGlobalFilter: false,
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <AudioDeploymentRowActions
            deployment={row.original}
            canEdit={isEditor}
          />
        ),
        enableSorting: false,
        enableGlobalFilter: false,
      },
    ],
    [isEditor, rangeSelection]
  );

  const filteredData = useMemo(() => {
    if (!projectFilter) return initialDeployments;
    return initialDeployments.filter(
      (d) => d.ctProjectName === projectFilter
    );
  }, [initialDeployments, projectFilter]);

  const table = useReactTable({
    data: filteredData,
    columns,
    state: { sorting, globalFilter, rowSelection },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    enableRowSelection: true,
    getRowId: (row) => String(row.id),
  });

  const selectedRows = table.getFilteredSelectedRowModel().rows;

  const filteredRowIds = useMemo(() => {
    return new Set(table.getFilteredRowModel().rows.map((r) => r.id));
  }, [table, globalFilter, sorting]); // eslint-disable-line react-hooks/exhaustive-deps

  // Map of deployment id → index in TanStack's sorted row model so we can
  // respect column-sort order within each project group.
  const sortedRows = table.getRowModel().rows;
  const sortedRowOrder = useMemo(() => {
    const map = new Map<number, number>();
    sortedRows.forEach((r, i) => map.set(r.original.id, i));
    return map;
  }, [sortedRows]);

  const sortedGroups = useMemo(() => {
    const filtered = projectFilter
      ? groups.filter((g) => g.projectLabel === projectFilter)
      : groups;
    return filtered.map((g) => ({
      ...g,
      deployments: [...g.deployments].sort(
        (a, b) =>
          (sortedRowOrder.get(a.id) ?? 0) - (sortedRowOrder.get(b.id) ?? 0)
      ),
    }));
  }, [groups, projectFilter, sortedRowOrder]);

  // Flat ordered list of currently visible deployment IDs, in the same order
  // they render: across groups, skipping collapsed ones, respecting filters.
  // Drives the shift+click range selection.
  const visibleOrderedIds = useMemo(() => {
    const ids: number[] = [];
    for (const group of sortedGroups) {
      if (collapsedGroups.has(group.projectLabel)) continue;
      for (const dep of group.deployments) {
        if (filteredRowIds.has(String(dep.id))) ids.push(dep.id);
      }
    }
    return ids;
  }, [sortedGroups, collapsedGroups, filteredRowIds]);
  rangeSelection.setVisibleOrderedIds(visibleOrderedIds);

  /**
   * Enqueue a background audio_sync job. The actual work (Drive listing +
   * audio_files reconciliation) runs server-side; the floating progress
   * widget shows live progress and survives navigation.
   */
  const triggerSync = (cameraTrapProjectId?: number) => {
    startSync(async () => {
      setSyncMessage(null);
      const result = await enqueueAudioSyncJob(cameraTrapProjectId);
      if (!result.success) {
        setSyncMessage(`Error: ${result.error}`);
        return;
      }
      const scopeLabel = cameraTrapProjectId
        ? distinctProjects.find((p) => p.id === cameraTrapProjectId)?.name ?? "proyecto"
        : "todos los proyectos";
      setSyncMessage(
        `Sincronización iniciada para ${scopeLabel}. Puedes seguir trabajando — el progreso se muestra en la esquina inferior derecha.`
      );
      setLastSyncAt(new Date().toISOString());
      window.dispatchEvent(new Event("job-started"));
    });
  };

  return (
    <div className="max-w-7xl mx-auto min-w-0">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-1 flex items-center gap-2">
          <AudioLines className="h-7 w-7" />
          Grabaciones
        </h1>
        <p className="text-muted-foreground text-sm">
          Gestiona instalaciones de audio, analiza con BirdNET y revisa detecciones.
        </p>
      </div>

      {/* Summary strip */}
      {initialDeployments.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md border bg-card px-4 py-2.5 text-sm">
          <SummaryStat label="Sin escanear" value={counts.sinEscanear} dotClass="bg-gray-400" valueClass="text-gray-600" />
          <span className="h-4 w-px bg-border" aria-hidden />
          <SummaryStat label="Escaneados" value={counts.escaneados} dotClass="bg-blue-600" valueClass="text-blue-700" />
          <span className="h-4 w-px bg-border" aria-hidden />
          <SummaryStat label="Procesando" value={counts.procesando} dotClass="bg-yellow-500" valueClass="text-yellow-600" />
          <span className="h-4 w-px bg-border" aria-hidden />
          <SummaryStat label="Por Revisar" value={counts.porRevisar} dotClass="bg-orange-500" valueClass="text-orange-600" />
          <span className="h-4 w-px bg-border" aria-hidden />
          <SummaryStat label="Revisados" value={counts.revisados} dotClass="bg-emerald-600" valueClass="text-emerald-700" />
          <span className="ml-auto text-xs text-muted-foreground">
            {initialDeployments.length} instalaciones en total
          </span>
        </div>
      )}

      {/* Toolbar */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {isEditor && (
          <div className="flex items-center gap-2">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="inline-flex">
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => triggerSync()}
                      disabled={syncing}
                      className="rounded-r-none"
                    >
                      {syncing ? (
                        <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                      ) : (
                        <RefreshCw className="h-4 w-4 mr-1.5" />
                      )}
                      Sincronizar audio
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="default"
                          size="sm"
                          disabled={syncing || distinctProjects.length === 0}
                          className="rounded-l-none border-l border-primary-foreground/20 px-2"
                          aria-label="Sincronizar audio de un proyecto específico"
                        >
                          <ChevronDown className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuLabel className="text-xs">
                          Sincronizar solo…
                        </DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        {distinctProjects.map((p) => (
                          <DropdownMenuItem
                            key={p.id}
                            onSelect={() => triggerSync(p.id)}
                          >
                            {p.name}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-xs">
                  <p className="text-xs leading-relaxed">
                    Inicia una sincronización en segundo plano: lista los
                    archivos de audio de cada instalación en Google Drive
                    y los reconcilia con el índice local. Puedes navegar a
                    otras páginas mientras se ejecuta.
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <span className="text-xs text-muted-foreground tabular-nums">
              {lastSyncAt
                ? `Última sincronización ${formatRelativeEs(lastSyncAt)}`
                : "Nunca sincronizado"}
            </span>
          </div>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-3">
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">Todos los proyectos</option>
            {distinctProjects.map((p) => (
              <option key={p.id} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>

          <div className="relative w-[260px]">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Buscar por nombre o sitio..."
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
              className="pl-9"
            />
          </div>
        </div>
      </div>

      {/* Sync message — brief banner; live progress lives in the floating widget */}
      {syncMessage && (
        <p className="mb-3 text-sm text-muted-foreground bg-muted/50 px-3 py-2 rounded-md">
          {syncMessage}
        </p>
      )}

      {/* Selection toolbar — actions wired up in Phase 5 */}
      {selectedRows.length > 0 && (
        <div className="mb-3 flex items-center gap-3 px-3 py-2 bg-muted/50 rounded-md">
          <span className="text-sm font-medium">
            {selectedRows.length} seleccionado(s)
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRowSelection({})}
            className="ml-auto"
          >
            Deseleccionar
          </Button>
        </div>
      )}

      {/* Table */}
      <div className="rounded-xl border overflow-auto">
        <Table className="text-xs">
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className={
                      header.column.getCanSort()
                        ? "cursor-pointer select-none"
                        : ""
                    }
                    onClick={
                      header.column.id !== "select"
                        ? header.column.getToggleSortingHandler()
                        : undefined
                    }
                  >
                    <span className="flex items-center gap-1">
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                      {header.column.getCanSort() &&
                        header.column.id !== "select" && (
                          <SortIcon direction={header.column.getIsSorted()} />
                        )}
                    </span>
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {sortedGroups.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="text-center text-muted-foreground py-8"
                >
                  No hay instalaciones con audio.
                  {isEditor && ' Usa "Sincronizar audio" para buscar archivos.'}
                </TableCell>
              </TableRow>
            ) : (
              sortedGroups.map((group) => {
                const isCollapsed = collapsedGroups.has(group.projectLabel);
                const selectableDepIds = group.deployments
                  .filter((d) => filteredRowIds.has(String(d.id)))
                  .map((d) => d.id);
                return (
                  <Fragment key={group.projectLabel}>
                    {/* Group header */}
                    <TableRow
                      className="bg-muted/30 hover:bg-muted/50 cursor-pointer border-b"
                      onClick={() => toggleGroup(group.projectLabel)}
                    >
                      <TableCell colSpan={columns.length} className="py-2.5 px-3">
                        <div className="flex items-center gap-2">
                          <GroupSelectAllCheckbox
                            groupDeploymentIds={selectableDepIds}
                            rowSelection={rowSelection}
                            setRowSelection={setRowSelection}
                            groupLabel={group.projectLabel}
                          />
                          <ChevronRight
                            className={`h-4 w-4 transition-transform shrink-0 ${!isCollapsed ? "rotate-90" : ""}`}
                          />
                          <span className="font-semibold text-sm">
                            {group.projectLabel}
                          </span>
                          <span className="text-muted-foreground text-xs">
                            {group.totalCount} instalaciones
                          </span>
                          {group.actionableCount > 0 && (
                            <span className="text-xs font-medium text-orange-600">
                              {group.actionableCount} pendiente{group.actionableCount !== 1 ? "s" : ""}
                            </span>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                    {/* Deployment rows */}
                    {!isCollapsed &&
                      group.deployments.map((dep) => {
                        const row = table.getRowModel().rowsById[String(dep.id)];
                        if (!row) return null;
                        if (!filteredRowIds.has(row.id)) return null;
                        return (
                          <TableRow
                            key={row.id}
                            className={`group/row cursor-pointer hover:bg-muted/50 ${dep.excluded ? "opacity-50" : ""}`}
                            data-state={row.getIsSelected() ? "selected" : undefined}
                            onClick={() => router.push(`/audio/${dep.id}`)}
                          >
                            {row.getVisibleCells().map((cell) => (
                              <TableCell key={cell.id}>
                                {flexRender(
                                  cell.column.columnDef.cell,
                                  cell.getContext()
                                )}
                              </TableCell>
                            ))}
                          </TableRow>
                        );
                      })}
                  </Fragment>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Row count */}
      <p className="mt-4 text-sm text-muted-foreground">
        {table.getFilteredRowModel().rows.length} instalaciones
        {(globalFilter || projectFilter) && " (filtradas)"}
      </p>
    </div>
  );
}

function SummaryStat({
  label,
  value,
  dotClass,
  valueClass,
}: {
  label: string;
  value: number;
  dotClass: string;
  valueClass: string;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`h-2 w-2 rounded-full ${dotClass}`} aria-hidden />
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-semibold tabular-nums ${valueClass}`}>{value}</span>
    </span>
  );
}

/** Compact Spanish relative time, e.g. "hace 5 min", "hace 2 h", "hace 3 d". */
function formatRelativeEs(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 60) return "hace unos segundos";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `hace ${diffMin} min`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `hace ${diffHr} h`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `hace ${diffDay} d`;
  const diffMo = Math.floor(diffDay / 30);
  if (diffMo < 12) return `hace ${diffMo} mes${diffMo === 1 ? "" : "es"}`;
  const diffYr = Math.floor(diffDay / 365);
  return `hace ${diffYr} año${diffYr === 1 ? "" : "s"}`;
}
