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
import {
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Search,
  RefreshCw,
  Loader2,
  Info,
  Download,
  ChevronRight,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { DeploymentRow } from "./actions";
import { DeploymentRowActions } from "./deployment-row-actions";
import { BatchEditDialog } from "./batch-edit-dialog";
import { BatchDeleteDialog } from "./batch-delete-dialog";
import { syncWithDrive, scanDeploymentImages } from "./drive-actions";
import { matchOdkDeployments } from "./odk-actions";
import { ProcessConfirmDialog } from "./process-confirm-dialog";
import type { ProjectGroup } from "./page";

export interface CtProject {
  id: number;
  name: string;
}

interface DeploymentsTableProps {
  groups: ProjectGroup[];
  deployments: DeploymentRow[];
  distinctProjects: CtProject[];
  canEdit: boolean;
  isAdmin: boolean;
}

export function DeploymentsTable({
  groups,
  deployments: initialDeployments,
  distinctProjects,
  canEdit,
  isAdmin,
}: DeploymentsTableProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [syncing, startSync] = useTransition();
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [batchEditOpen, setBatchEditOpen] = useState(false);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [processDialogIds, setProcessDialogIds] = useState<number[] | null>(null);
  const [exporting, setExporting] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set()
  );
  const router = useRouter();

  // Refresh table data when a job reaches a terminal state
  useEffect(() => {
    const handleJobsUpdated = () => {
      router.refresh();
    };
    window.addEventListener("jobs-updated", handleJobsUpdated);
    return () => window.removeEventListener("jobs-updated", handleJobsUpdated);
  }, [router]);

  // Apply status filter to the flat data for TanStack
  const filteredData = useMemo(() => {
    let data = initialDeployments;
    if (statusFilter) {
      data = data.filter((d) => d.status === statusFilter);
    }
    return data;
  }, [initialDeployments, statusFilter]);

  // Build filtered groups from the server-provided groups + client filters
  const filteredGroups = useMemo(() => {
    return groups
      .map((g) => {
        let deps = g.deployments;
        if (statusFilter) {
          deps = deps.filter((d) => d.status === statusFilter);
        }
        if (globalFilter) {
          const lower = globalFilter.toLowerCase();
          deps = deps.filter(
            (d) =>
              d.name.toLowerCase().includes(lower) ||
              (d.projectLabel?.toLowerCase().includes(lower) ?? false) ||
              (d.siteName?.toLowerCase().includes(lower) ?? false)
          );
        }
        return { ...g, deployments: deps, totalCount: deps.length };
      })
      .filter((g) => g.deployments.length > 0);
  }, [groups, statusFilter, globalFilter]);

  const toggleGroup = useCallback((projectLabel: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(projectLabel)) {
        next.delete(projectLabel);
      } else {
        next.add(projectLabel);
      }
      return next;
    });
  }, []);

  const expandAll = useCallback(() => setCollapsedGroups(new Set()), []);
  const collapseAll = useCallback(
    () => setCollapsedGroups(new Set(groups.map((g) => g.projectLabel))),
    [groups]
  );

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
                  <span className="inline-flex items-center gap-1.5"><StatusBadge status="scanned" type="deployment" /> Lista para procesar con ML</span>
                  <span className="inline-flex items-center gap-1.5"><StatusBadge status="processing" type="deployment" /> Modelo ML analizando</span>
                  <span className="inline-flex items-center gap-1.5"><StatusBadge status="processed" type="deployment" /> Tiene detecciones por revisar</span>
                  <span className="inline-flex items-center gap-1.5"><StatusBadge status="processed_empty" type="deployment" /> Procesada, sin detecciones</span>
                  <span className="inline-flex items-center gap-1.5"><StatusBadge status="verified" type="deployment" /> Revisada por investigador</span>
                  <span className="inline-flex items-center gap-1.5"><StatusBadge status="verified_empty" type="deployment" /> Sin detecciones, confirmada</span>
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ),
        cell: ({ row }) => {
          const d = row.original;
          const displayStatus = d.status === "processed" && (d.totalDetections == null || d.totalDetections === 0)
            ? "processed_empty"
            : d.status;
          const showProgress = (d.status === "processed" || d.status === "verified") &&
            d.totalIdentifications != null && d.totalIdentifications > 0;
          return (
            <span className="inline-flex items-center gap-1">
              <StatusBadge status={displayStatus} type="deployment" />
              {showProgress && (
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {d.reviewedCount ?? 0}/{d.totalIdentifications} revisadas
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
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <DeploymentRowActions
            deployment={row.original}
            canEdit={canEdit}
            isAdmin={isAdmin}
          />
        ),
        enableSorting: false,
        enableGlobalFilter: false,
      },
    );

    return cols;
  }, [canEdit, isAdmin]);

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
    setProcessDialogIds(selectedIds);
  };

  const handleProcessStarted = () => {
    setRowSelection({});
    window.dispatchEvent(new Event("job-started"));
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

  // Build a set of row IDs that pass the global filter for grouped rendering
  const filteredRowIds = useMemo(() => {
    return new Set(table.getFilteredRowModel().rows.map((r) => r.id));
  }, [table]);

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
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">Todos los estados</option>
          <option value="unscanned">Por Procesar (nueva)</option>
          <option value="scanned">Por Procesar</option>
          <option value="processing">Procesando</option>
          <option value="processed">Por Revisar</option>
          <option value="verified">Verificada</option>
          <option value="verified_empty">Vacía (verificada)</option>
        </select>

        <div className="flex gap-1">
          <Button variant="ghost" size="sm" onClick={expandAll} className="text-xs">
            Expandir
          </Button>
          <Button variant="ghost" size="sm" onClick={collapseAll} className="text-xs">
            Colapsar
          </Button>
        </div>

        {canEdit && (
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
                >
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
            {filteredGroups.length === 0 ? (
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
              filteredGroups.map((group) => {
                const isCollapsed = collapsedGroups.has(group.projectLabel);
                const actionable = group.deployments.filter((d) =>
                  ["unscanned", "scanned", "processing", "processed"].includes(d.status)
                ).length;

                return (
                  <Fragment key={group.projectLabel}>
                    {/* Group header row */}
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
                          {actionable > 0 && (
                            <span className="text-xs font-medium text-orange-600">
                              {actionable} pendiente{actionable !== 1 ? "s" : ""}
                            </span>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                    {/* Deployment rows within group */}
                    {!isCollapsed &&
                      group.deployments.map((dep) => {
                        const row = table.getRowModel().rowsById[String(dep.id)];
                        if (!row) return null;
                        // Skip rows that don't match global filter
                        if (!filteredRowIds.has(row.id)) return null;
                        return (
                          <TableRow
                            key={row.id}
                            className={`cursor-pointer hover:bg-muted/50 ${dep.excluded ? "opacity-50" : ""}`}
                            data-state={row.getIsSelected() ? "selected" : undefined}
                            onClick={() => router.push(`/camera-trap/${dep.id}`)}
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
      <p className="text-sm text-muted-foreground">
        {table.getFilteredRowModel().rows.length} instalaciones
        {(globalFilter || statusFilter) && " (filtradas)"}
      </p>

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
          <ProcessConfirmDialog
            deploymentIds={processDialogIds}
            isAdmin={isAdmin}
            onClose={() => setProcessDialogIds(null)}
            onStarted={handleProcessStarted}
          />
        </>
      )}
    </div>
  );
}
