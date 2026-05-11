"use client";

import { useState, useMemo, useCallback, useTransition, Fragment } from "react";
import { useRouter } from "next/navigation";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
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
import { StatusBadge } from "@/components/status-badge";
import { SortIcon } from "@/components/sort-icon";
import {
  Search,
  FolderSync,
  Loader2,
  AudioLines,
  ChevronRight,
} from "lucide-react";
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
}

export function AudioDeploymentsShell({
  groups,
  deployments: initialDeployments,
  counts,
  distinctProjects,
  isEditor,
}: AudioDeploymentsShellProps) {
  const router = useRouter();
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [syncing, startSync] = useTransition();
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set()
  );

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
    [isEditor]
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
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getRowId: (row) => String(row.id),
  });

  const filteredRowIds = useMemo(() => {
    return new Set(table.getFilteredRowModel().rows.map((r) => r.id));
  }, [table, globalFilter, sorting]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-group based on project filter
  const sortedGroups = useMemo(() => {
    if (!projectFilter) return groups;
    return groups.filter((g) => g.projectLabel === projectFilter);
  }, [groups, projectFilter]);

  const handleScanAll = () => {
    startSync(async () => {
      setSyncMessage(null);
      try {
        const result = await enqueueAudioSyncJob();
        if (!result.success) {
          setSyncMessage(`Error: ${result.error}`);
          return;
        }
        setSyncMessage(
          "Sincronización iniciada. Puedes seguir trabajando — el progreso se muestra en la esquina inferior derecha."
        );
        // Wake FloatingJobProgress immediately instead of waiting up to 3s
        // for the next mount-time poll tick.
        window.dispatchEvent(new Event("job-started"));
      } catch (err) {
        setSyncMessage(
          err instanceof Error ? err.message : "Error inesperado"
        );
      }
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
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por nombre o sitio..."
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="pl-9"
          />
        </div>

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

        {isEditor && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleScanAll}
            disabled={syncing}
          >
            {syncing ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : (
              <FolderSync className="h-4 w-4 mr-1.5" />
            )}
            Escanear Todo
          </Button>
        )}
      </div>

      {/* Sync message */}
      {syncMessage && (
        <p className="mb-3 text-sm text-muted-foreground bg-muted/50 px-3 py-2 rounded-md">
          {syncMessage}
        </p>
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
                    onClick={header.column.getToggleSortingHandler()}
                  >
                    <span className="flex items-center gap-1">
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                      {header.column.getCanSort() && (
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
                  {isEditor && ' Usa "Escanear Todo" para buscar archivos.'}
                </TableCell>
              </TableRow>
            ) : (
              sortedGroups.map((group) => {
                const isCollapsed = collapsedGroups.has(group.projectLabel);
                return (
                  <Fragment key={group.projectLabel}>
                    {/* Group header */}
                    <TableRow
                      className="bg-muted/30 hover:bg-muted/50 cursor-pointer border-b"
                      onClick={() => toggleGroup(group.projectLabel)}
                    >
                      <TableCell colSpan={columns.length} className="py-2.5 px-3">
                        <div className="flex items-center gap-2">
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
                            className={`cursor-pointer hover:bg-muted/50 ${dep.excluded ? "opacity-50" : ""}`}
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
