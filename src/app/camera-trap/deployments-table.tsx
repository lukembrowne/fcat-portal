"use client";

import { useState, useMemo, useCallback, useTransition } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  getFilteredRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
  type PaginationState,
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
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Search,
  RefreshCw,
  Loader2,
} from "lucide-react";
import type { DeploymentRow } from "./actions";
import { DeploymentPanel } from "./deployment-panel";
import { BatchEditDialog } from "./batch-edit-dialog";
import { BatchDeleteDialog } from "./batch-delete-dialog";
import { syncWithDrive } from "./drive-actions";
import { matchOdkDeployments } from "./odk-actions";
import { queueProcessing } from "./actions";

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
  const [selectedDeployment, setSelectedDeployment] = useState<DeploymentRow | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [projectFilter, setProjectFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [syncing, startSync] = useTransition();
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [batchEditOpen, setBatchEditOpen] = useState(false);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [processing, startProcessing] = useTransition();

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
      }
    );

    return cols;
  }, [canEdit]);

  const table = useReactTable({
    data: filteredData,
    columns,
    state: { sorting, globalFilter, pagination, rowSelection },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onPaginationChange: setPagination,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    enableRowSelection: canEdit,
    getRowId: (row) => String(row.id),
  });

  const selectedRows = table.getFilteredSelectedRowModel().rows;
  const selectedIds = selectedRows.map((r) => r.original.id);

  const handleRowClick = useCallback(
    (row: DeploymentRow) => {
      setSelectedDeployment(row);
      setPanelOpen(true);
      // Clear selection when opening panel
      if (Object.keys(rowSelection).length > 0) {
        setRowSelection({});
      }
    },
    [rowSelection]
  );

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
                <TableRow
                  key={row.id}
                  className="cursor-pointer hover:bg-muted/50"
                  data-state={row.getIsSelected() ? "selected" : undefined}
                  onClick={() => handleRowClick(row.original)}
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

      {/* Side panel */}
      <DeploymentPanel
        deployment={selectedDeployment}
        open={panelOpen}
        onOpenChange={setPanelOpen}
        canEdit={canEdit}
        distinctProjects={distinctProjects}
      />

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
