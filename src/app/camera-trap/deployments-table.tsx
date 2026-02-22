"use client";

import { useState, useMemo, useCallback, useRef, useTransition, useEffect, Fragment } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
  Eye,
  Info,
  Download,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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

export interface CtProject {
  id: number;
  name: string;
}

interface DeploymentsTableProps {
  deployments: DeploymentRow[];
  distinctProjects: CtProject[];
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
  const [exporting, setExporting] = useState(false);
  const router = useRouter();

  // Cache for loaded job data per deployment
  const jobsCacheRef = useRef<Map<number, JobInfo[]>>(new Map());
  const handleCacheJobs = useCallback((deploymentId: number, jobs: JobInfo[]) => {
    jobsCacheRef.current.set(deploymentId, jobs);
  }, []);

  // Refresh table data when a job reaches a terminal state
  useEffect(() => {
    const handleJobsUpdated = () => {
      jobsCacheRef.current.clear();
      router.refresh();
    };
    window.addEventListener("jobs-updated", handleJobsUpdated);
    return () => window.removeEventListener("jobs-updated", handleJobsUpdated);
  }, [router]);

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
    const cols: ColumnDef<DeploymentRow>[] = [
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
            onCheckedChange={(value) => row.toggleSelected(!!value)}
            aria-label="Seleccionar fila"
            onClick={(e) => e.stopPropagation()}
          />
        ),
        enableSorting: false,
        enableGlobalFilter: false,
      },
    ];

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
        header: () => (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1">
                  Estado
                  <Info className="h-3.5 w-3.5 text-muted-foreground" />
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs bg-popover text-popover-foreground border shadow-md p-3">
                <div className="flex flex-col gap-1.5 text-xs">
                  <span className="inline-flex items-center gap-1.5"><StatusBadge status="unscanned" type="deployment" /> Carpeta importada, imágenes no buscadas</span>
                  <span className="inline-flex items-center gap-1.5"><StatusBadge status="scanned" type="deployment" /> Imágenes contadas, lista para procesar</span>
                  <span className="inline-flex items-center gap-1.5"><StatusBadge status="processing" type="deployment" /> Modelo ML analizando</span>
                  <span className="inline-flex items-center gap-1.5"><StatusBadge status="processed" type="deployment" /> Análisis ML completado</span>
                  <span className="inline-flex items-center gap-1.5"><StatusBadge status="verified" type="deployment" /> Revisada por investigador</span>
                  <span className="inline-flex items-center gap-1.5"><StatusBadge status="verified_empty" type="deployment" /> Sin detecciones, confirmada por investigador</span>
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ),
        cell: ({ getValue }) => (
          <StatusBadge status={getValue<string>()} type="deployment" />
        ),
      },
      {
        accessorKey: "totalImages",
        header: "Archivos",
        cell: ({ row }) => {
          const imgs = row.original.totalImages;
          const vids = row.original.totalVideos;
          const hasImgs = imgs != null && imgs > 0;
          const hasVids = vids != null && vids > 0;
          if (!hasImgs && !hasVids) return "—";
          return (
            <span className="tabular-nums">
              {hasImgs ? `${imgs.toLocaleString()} img` : ""}
              {hasImgs && hasVids ? ", " : ""}
              {hasVids ? `${vids.toLocaleString()} vid` : ""}
            </span>
          );
        },
        enableGlobalFilter: false,
      },
      {
        accessorKey: "totalDetections",
        header: "Detecciones",
        cell: ({ getValue }) => {
          const v = getValue<number | null>();
          if (v == null) return "—";
          return (
            <span className="tabular-nums">
              {v > 0 ? v.toLocaleString() : "0"}
            </span>
          );
        },
        enableGlobalFilter: false,
      },
      {
        accessorKey: "distinctSpecies",
        header: "Especies",
        cell: ({ getValue }) => {
          const v = getValue<number | null>();
          if (v == null) return "—";
          return (
            <span className="tabular-nums">
              {v > 0 ? v.toLocaleString() : "0"}
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
  }, []);

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
    autoResetExpanded: false,
    enableRowSelection: true,
    getRowCanExpand: () => true,
    getRowId: (row) => String(row.id),
  });

  const selectedRows = table.getFilteredSelectedRowModel().rows;
  const selectedIds = selectedRows.map((r) => r.original.id);

  const handleSync = () => {
    startSync(async () => {
      setSyncMessage(null);
      const messages: string[] = [];

      // Step 1: Sync with Drive (discovers new folders, auto-scans them)
      const result = await syncWithDrive();
      if (!result.success) {
        setSyncMessage(`Error: ${result.error}`);
        return;
      }

      const { created, errors } = result.data;
      if (created.length > 0) {
        // Step 2: Auto-match new deployments with ODK
        const odkResult = await matchOdkDeployments(
          created.map((d) => d.id)
        );
        const matchCount = odkResult.success
          ? odkResult.data.matched.length
          : 0;
        messages.push(
          `${created.length} nueva(s) instalación(es). ${matchCount} vinculada(s) con ODK.`
        );
        if (errors.length > 0) {
          messages.push(`${errors.length} error(es) de sincronización.`);
        }
      }

      // Step 3: Scan remaining unscanned and 0-image deployments
      const needsScan = initialDeployments.filter(
        (d) =>
          d.status === "unscanned" ||
          (d.status === "scanned" && (d.totalImages == null || d.totalImages === 0))
      );

      if (needsScan.length > 0) {
        let scanned = 0;
        let scanErrors = 0;
        for (let i = 0; i < needsScan.length; i++) {
          setSyncMessage(
            `Buscando imágenes ${i + 1}/${needsScan.length}...`
          );
          const scanResult = await scanDeploymentImages(needsScan[i].id);
          if (scanResult.success) {
            scanned++;
          } else {
            scanErrors++;
          }
        }
        messages.push(
          `${scanned} instalación(es) escaneada(s).${scanErrors > 0 ? ` ${scanErrors} error(es).` : ""}`
        );
      }

      setSyncMessage(
        messages.length > 0
          ? messages.join(" ")
          : "Todo sincronizado. No hay cambios."
      );
    });
  };

  const handleBatchProcess = () => {
    startProcessing(async () => {
      const result = await queueProcessing(selectedIds);
      if (result.success) {
        setRowSelection({});
        window.dispatchEvent(new Event("job-started"));
      }
    });
  };

  const handleExport = async () => {
    const allSelected = table.getFilteredSelectedRowModel().rows;
    const processedStatuses = new Set(["processed", "verified", "verified_empty"]);
    const valid = allSelected.filter((r) => processedStatuses.has(r.original.status));
    const excluded = allSelected.length - valid.length;

    if (valid.length === 0) {
      setSyncMessage("No hay instalaciones procesadas para exportar.");
      return;
    }

    if (excluded > 0) {
      setSyncMessage(
        `${excluded} instalación(es) sin procesar no incluida(s) en la exportación.`
      );
    }

    setExporting(true);
    try {
      const ids = valid.map((r) => r.original.id).join(",");
      const response = await fetch(`/api/camera-trap/export?ids=${ids}`);

      if (!response.ok) {
        let msg = "Error al exportar";
        try {
          msg = (await response.json()).error || msg;
        } catch {}
        setSyncMessage(msg);
        return;
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `camtrap-dp-${new Date().toISOString().split("T")[0]}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);

      setSyncMessage(
        `Exportación completada: ${valid.length} instalación(es) en formato Camtrap DP.`
      );
    } catch {
      setSyncMessage("Error al exportar los datos.");
    } finally {
      setExporting(false);
    }
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
            <option key={p.id} value={p.name}>
              {p.name}
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
          <option value="verified_empty">Vacía verificada</option>
        </select>

        {canEdit && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSync}
              disabled={syncing}
            >
              {syncing ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-1.5" />
              )}
              Sincronizar con Drive
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
      {selectedRows.length > 0 && (
        <div className="flex items-center gap-3 px-3 py-2 bg-muted/50 rounded-md">
          <span className="text-sm font-medium">
            {selectedRows.length} seleccionado(s)
          </span>
          <div className="flex gap-2">
            {canEdit && (
              <>
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
              </>
            )}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleExport}
                    disabled={exporting}
                  >
                    {exporting ? (
                      <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4 mr-1.5" />
                    )}
                    {exporting ? "Exportando..." : "Exportar Camtrap DP"}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  Descargar un paquete de datos estandarizado (Camtrap DP)
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
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
