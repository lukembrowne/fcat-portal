"use client";

import { useState, useMemo, useCallback, useRef, useTransition, Fragment } from "react";
import Link from "next/link";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  getFilteredRowModel,
  getExpandedRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
  type PaginationState,
  type RowSelectionState,
  type ExpandedState,
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
import {
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Search,
  RefreshCw,
  Loader2,
  ScanSearch,
  Eye,
} from "lucide-react";
import type { DeploymentRow } from "./actions";
import { DeploymentExpandedRow } from "./deployment-expanded-row";
import { BatchEditDialog } from "./batch-edit-dialog";
import { BatchDeleteDialog } from "./batch-delete-dialog";
import { syncWithDrive, scanDeploymentImages } from "./drive-actions";
import { matchOdkDeployments } from "./odk-actions";
import { queueProcessing } from "./actions";

interface JobInfo {
  id: number;
  status: string;
  detectorModel: string | null;
  classifierModel: string | null;
  totalImages: number;
  processedImages: number;
  createdAt: Date;
  completedAt: Date | null;
}

interface DeploymentsTableProps {
  deployments: DeploymentRow[];
  distinctProjects: string[];
  canEdit: boolean;
}

export function DeploymentsTable({
  deployments: initialDeployments,
  distinctProjects,
  canEdit,
}: DeploymentsTableProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 25,
  });
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const [projectFilter, setProjectFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [syncing, startSync] = useTransition();
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [batchEditOpen, setBatchEditOpen] = useState(false);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [processing, startProcessing] = useTransition();
  const [scanProgress, setScanProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);

  // Cache for loaded job data per deployment
  const jobsCacheRef = useRef<Map<number, JobInfo[]>>(new Map());
  const handleCacheJobs = useCallback((deploymentId: number, jobs: JobInfo[]) => {
    jobsCacheRef.current.set(deploymentId, jobs);
  }, []);

  // Apply dropdown filters
  const filteredData = useMemo(() => {
    let data = initialDeployments;
    if (projectFilter) {
      data = data.filter((d) => d.projectLabel === projectFilter);
    }
    if (statusFilter) {
      data = data.filter((d) => d.status === statusFilter);
    }
    return data;
  }, [initialDeployments, projectFilter, statusFilter]);

  const columns = useMemo<ColumnDef<DeploymentRow>[]>(() => {
    const cols: ColumnDef<DeploymentRow>[] = [];

    if (canEdit) {
      cols.push({
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
            onCheckedChange={(value) => row.toggleSelected(!!value)}
            aria-label="Seleccionar fila"
            onClick={(e) => e.stopPropagation()}
          />
        ),
        enableSorting: false,
        enableGlobalFilter: false,
      });
    }

    cols.push(
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
        accessorKey: "projectLabel",
        header: "Proyecto",
        cell: ({ getValue }) => getValue<string | null>() || "—",
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
        accessorKey: "status",
        header: "Estado",
        cell: ({ getValue }) => (
          <StatusBadge status={getValue<string>()} type="deployment" />
        ),
      },
      {
        accessorKey: "totalImages",
        header: "Imágenes",
        cell: ({ getValue }) => {
          const v = getValue<number | null>();
          return (
            <span className="tabular-nums">
              {v != null && v > 0 ? v.toLocaleString() : "—"}
            </span>
          );
        },
        enableGlobalFilter: false,
      },
      {
        accessorKey: "lastProcessedAt",
        header: "Último Proceso",
        cell: ({ getValue }) => {
          const v = getValue<Date | null>();
          if (!v) return "—";
          return (
            <span className="tabular-nums text-muted-foreground">
              {new Date(v).toLocaleDateString("es-EC", {
                year: "numeric",
                month: "short",
                day: "numeric",
              })}
            </span>
          );
        },
        enableGlobalFilter: false,
      },
      {
        id: "results",
        header: "",
        cell: ({ row }) => {
          const jobId = row.original.lastCompletedJobId;
          if (!jobId) return null;
          return (
            <Link
              href={`/camera-trap/results/${jobId}`}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 hover:underline whitespace-nowrap"
            >
              <Eye className="h-3.5 w-3.5" />
              Resultados
            </Link>
          );
        },
        enableSorting: false,
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
        id: "location",
        header: "Ubicación",
        accessorFn: (row) =>
          row.latitude != null ? `${row.latitude},${row.longitude}` : "",
        cell: ({ row }) => {
          const { latitude, longitude } = row.original;
          if (latitude == null || longitude == null) return "—";
          return (
            <span className="tabular-nums text-muted-foreground whitespace-nowrap">
              {latitude.toFixed(4)}, {longitude.toFixed(4)}
            </span>
          );
        },
        enableGlobalFilter: false,
      },
      {
        id: "expand",
        header: "",
        cell: ({ row }) => (
          <ChevronRight className={`h-4 w-4 text-muted-foreground transition-transform ${row.getIsExpanded() ? "rotate-90" : ""}`} />
        ),
        enableSorting: false,
        enableGlobalFilter: false,
      }
    );

    return cols;
  }, [canEdit]);

  // Accordion behavior: only allow one expanded row at a time
  const handleExpandedChange = useCallback((updater: ExpandedState | ((old: ExpandedState) => ExpandedState)) => {
    setExpanded((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      if (next === true) return next;
      // Find newly expanded rows (keys that are true in next but not in prev)
      const prevKeys = prev === true ? [] : Object.keys(prev).filter((k) => prev[k]);
      const nextKeys = Object.keys(next).filter((k) => next[k]);
      const newlyExpanded = nextKeys.filter((k) => !prevKeys.includes(k));
      // If a new row was expanded, collapse all others (accordion)
      if (newlyExpanded.length > 0) {
        return { [newlyExpanded[newlyExpanded.length - 1]]: true };
      }
      return next;
    });
  }, []);

  const table = useReactTable({
    data: filteredData,
    columns,
    state: { sorting, globalFilter, pagination, rowSelection, expanded },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onPaginationChange: (updater) => {
      setPagination(updater);
      setExpanded({}); // Collapse on page change
    },
    onRowSelectionChange: setRowSelection,
    onExpandedChange: handleExpandedChange,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    enableRowSelection: canEdit,
    getRowCanExpand: () => true,
    getRowId: (row) => String(row.id),
  });

  const selectedRows = table.getFilteredSelectedRowModel().rows;
  const selectedIds = selectedRows.map((r) => r.original.id);

  const handleSync = () => {
    startSync(async () => {
      setSyncMessage(null);
      const result = await syncWithDrive();
      if (result.success) {
        const { created, errors } = result.data;
        // Auto-match new deployments with ODK
        if (created.length > 0) {
          const odkResult = await matchOdkDeployments(
            created.map((d) => d.id)
          );
          const matchCount = odkResult.success
            ? odkResult.data.matched.length
            : 0;
          setSyncMessage(
            `${created.length} nueva(s) instalación(es) encontrada(s). ${matchCount} vinculada(s) con ODK.${errors.length > 0 ? ` ${errors.length} error(es).` : ""}`
          );
        } else {
          setSyncMessage("No se encontraron nuevas carpetas en Drive.");
        }
      } else {
        setSyncMessage(`Error: ${result.error}`);
      }
    });
  };

  const handleBatchProcess = () => {
    startProcessing(async () => {
      const result = await queueProcessing(selectedIds);
      if (result.success) {
        setRowSelection({});
      }
    });
  };

  const handleBatchScan = async () => {
    const unscanned = initialDeployments.filter(
      (d) => d.status === "unscanned"
    );
    if (unscanned.length === 0) {
      setSyncMessage("No hay instalaciones sin escanear.");
      return;
    }
    setScanProgress({ current: 0, total: unscanned.length });
    setSyncMessage(null);
    let successCount = 0;
    let errorCount = 0;
    for (let i = 0; i < unscanned.length; i++) {
      setScanProgress({ current: i + 1, total: unscanned.length });
      const result = await scanDeploymentImages(unscanned[i].id);
      if (result.success) {
        successCount++;
      } else {
        errorCount++;
      }
    }
    setScanProgress(null);
    setSyncMessage(
      `Escaneo completo: ${successCount} instalación(es) escaneada(s).${errorCount > 0 ? ` ${errorCount} error(es).` : ""}`
    );
  };

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por nombre, proyecto, sitio..."
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="pl-9"
          />
        </div>

        <select
          value={projectFilter}
          onChange={(e) => {
            setProjectFilter(e.target.value);
            setPagination((p) => ({ ...p, pageIndex: 0 }));
          }}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">Todos los proyectos</option>
          {distinctProjects.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>

        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPagination((p) => ({ ...p, pageIndex: 0 }));
          }}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">Todos los estados</option>
          <option value="unscanned">Sin escanear</option>
          <option value="scanned">Escaneada</option>
          <option value="processing">Procesando</option>
          <option value="processed">Procesada</option>
          <option value="verified">Verificada</option>
        </select>

        {canEdit && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSync}
              disabled={syncing || scanProgress !== null}
            >
              {syncing ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-1.5" />
              )}
              Sincronizar con Drive
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleBatchScan}
              disabled={syncing || scanProgress !== null}
            >
              {scanProgress ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <ScanSearch className="h-4 w-4 mr-1.5" />
              )}
              {scanProgress
                ? `Escaneando ${scanProgress.current}/${scanProgress.total}...`
                : "Escanear Todo"}
            </Button>
          </>
        )}
      </div>

      {/* Sync message */}
      {syncMessage && (
        <p className="text-sm text-muted-foreground bg-muted/50 px-3 py-2 rounded-md">
          {syncMessage}
        </p>
      )}

      {/* Selection toolbar */}
      {canEdit && selectedRows.length > 0 && (
        <div className="flex items-center gap-3 px-3 py-2 bg-muted/50 rounded-md">
          <span className="text-sm font-medium">
            {selectedRows.length} seleccionado(s)
          </span>
          <div className="flex gap-2">
            <Button
              variant="default"
              size="sm"
              onClick={handleBatchProcess}
              disabled={processing}
            >
              {processing ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : null}
              Procesar Seleccionados
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setBatchEditOpen(true)}
            >
              Editar Seleccionados
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setBatchDeleteOpen(true)}
            >
              Eliminar
            </Button>
          </div>
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
                        header.column.id !== "select" &&
                        ({
                          asc: <ArrowUp className="h-3.5 w-3.5" />,
                          desc: <ArrowDown className="h-3.5 w-3.5" />,
                        }[header.column.getIsSorted() as string] ?? (
                          <ArrowUpDown className="h-3.5 w-3.5 opacity-30" />
                        ))}
                    </span>
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="text-center text-muted-foreground py-8"
                >
                  No hay instalaciones.{" "}
                  {canEdit &&
                    "Usa \"Sincronizar con Drive\" para buscar carpetas."}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <Fragment key={row.id}>
                  <TableRow
                    className={`cursor-pointer hover:bg-muted/50 ${row.getIsExpanded() ? "bg-primary/10 border-b-0" : ""}`}
                    data-state={row.getIsSelected() ? "selected" : undefined}
                    onClick={() => row.toggleExpanded()}
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
                  {row.getIsExpanded() && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell
                        colSpan={columns.length}
                        className="p-0"
                      >
                        <DeploymentExpandedRow
                          deployment={row.original}
                          canEdit={canEdit}
                          distinctProjects={distinctProjects}
                          cachedJobs={jobsCacheRef.current.get(row.original.id)}
                          onCacheJobs={handleCacheJobs}
                        />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between text-sm">
        <p className="text-muted-foreground">
          {table.getFilteredRowModel().rows.length} instalaciones
          {(globalFilter || projectFilter || statusFilter) && " (filtradas)"}
        </p>
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() => table.firstPage()}
            disabled={!table.getCanPreviousPage()}
          >
            <ChevronsLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="px-2 text-muted-foreground">
            {table.getState().pagination.pageIndex + 1} /{" "}
            {table.getPageCount()}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() => table.lastPage()}
            disabled={!table.getCanNextPage()}
          >
            <ChevronsRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Batch dialogs */}
      {canEdit && (
        <>
          <BatchEditDialog
            open={batchEditOpen}
            onOpenChange={setBatchEditOpen}
            selectedIds={selectedIds}
            selectedCount={selectedRows.length}
            distinctProjects={distinctProjects}
            onComplete={() => setRowSelection({})}
          />
          <BatchDeleteDialog
            open={batchDeleteOpen}
            onOpenChange={setBatchDeleteOpen}
            selectedIds={selectedIds}
            selectedCount={selectedRows.length}
            onComplete={() => setRowSelection({})}
          />
        </>
      )}
    </div>
  );
}
