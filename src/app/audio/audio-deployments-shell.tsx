"use client";

import { useState, useMemo, useCallback, useTransition, Fragment } from "react";
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
import { Badge } from "@/components/ui/badge";
import {
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Search,
  FolderSync,
  Loader2,
  AudioLines,
} from "lucide-react";
import { scanAllAudio } from "./actions";
import type { AudioDeploymentRow, AudioProject } from "./actions";
import { AudioExpandedRow } from "./audio-expanded-row";

function getAudioStatus(
  row: AudioDeploymentRow
): { label: string; variant: "outline" | "secondary" | "destructive" } {
  if (row.lastScanned === null && row.audioFileCount === 0) {
    return { label: "Sin escanear", variant: "outline" };
  }
  if (row.audioFileCount > 0) {
    return { label: "Escaneado", variant: "secondary" };
  }
  return { label: "Vacío", variant: "destructive" };
}

export function AudioDeploymentsShell({
  deployments: initialDeployments,
  distinctProjects,
  isEditor,
}: {
  deployments: AudioDeploymentRow[];
  distinctProjects: AudioProject[];
  isEditor: boolean;
}) {
  const router = useRouter();
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 25,
  });
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const [projectFilter, setProjectFilter] = useState("");
  const [syncing, startSync] = useTransition();
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  // Pre-filter by project dropdown
  const filteredData = useMemo(() => {
    if (!projectFilter) return initialDeployments;
    return initialDeployments.filter(
      (d) => d.ctProjectName === projectFilter
    );
  }, [initialDeployments, projectFilter]);

  const columns = useMemo<ColumnDef<AudioDeploymentRow>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Instalación",
        cell: ({ getValue }) => (
          <span className="font-medium whitespace-normal">
            {getValue<string>()}
          </span>
        ),
      },
      {
        accessorKey: "ctProjectName",
        header: "Proyecto",
        cell: ({ getValue }) => {
          const v = getValue<string | null>();
          return v ? <Badge variant="outline">{v}</Badge> : "—";
        },
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
        id: "status",
        header: "Estado",
        accessorFn: (row) => {
          if (row.audioFileCount > 0) return "escaneado";
          if (row.lastScanned !== null) return "vacio";
          return "sin_escanear";
        },
        cell: ({ row }) => {
          const status = getAudioStatus(row.original);
          return <Badge variant={status.variant}>{status.label}</Badge>;
        },
        enableGlobalFilter: false,
      },
      {
        id: "audioFileCount",
        header: "Archivos",
        accessorFn: (row) => row.audioFileCount,
        cell: ({ row }) => {
          const count = row.original.audioFileCount;
          return (
            <span className="tabular-nums">
              {count > 0 ? count.toLocaleString() : "—"}
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
        id: "expand",
        header: "",
        cell: ({ row }) => (
          <ChevronRight
            className={`h-4 w-4 text-muted-foreground transition-transform ${row.getIsExpanded() ? "rotate-90" : ""}`}
          />
        ),
        enableSorting: false,
        enableGlobalFilter: false,
      },
    ],
    []
  );

  // Accordion: one expanded row at a time
  const handleExpandedChange = useCallback(
    (updater: ExpandedState | ((old: ExpandedState) => ExpandedState)) => {
      setExpanded((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        if (next === true) return next;
        const prevKeys =
          prev === true ? [] : Object.keys(prev).filter((k) => prev[k]);
        const nextKeys = Object.keys(next).filter((k) => next[k]);
        const newlyExpanded = nextKeys.filter((k) => !prevKeys.includes(k));
        if (newlyExpanded.length > 0) {
          return { [newlyExpanded[newlyExpanded.length - 1]]: true };
        }
        return next;
      });
    },
    []
  );

  const table = useReactTable({
    data: filteredData,
    columns,
    state: { sorting, globalFilter, pagination, expanded },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onPaginationChange: (updater) => {
      setPagination(updater);
      setExpanded({});
    },
    onExpandedChange: handleExpandedChange,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    autoResetExpanded: false,
    getRowCanExpand: () => true,
    getRowId: (row) => String(row.id),
  });

  const handleScanAll = () => {
    startSync(async () => {
      setSyncMessage("Escaneando archivos de audio...");
      try {
        const result = await scanAllAudio();
        if (result.success) {
          setSyncMessage(
            `${result.data.scanned} escaneado(s). ${result.data.errors > 0 ? `${result.data.errors} error(es).` : "Sin errores."}`
          );
          router.refresh();
        } else {
          setSyncMessage(result.error);
        }
      } catch (err) {
        setSyncMessage(
          err instanceof Error ? err.message : "Error inesperado"
        );
      }
    });
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <AudioLines className="h-6 w-6" />
            Grabaciones
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Archivos de audio de grabadoras pasivas
          </p>
        </div>
      </div>

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
        <p className="text-sm text-muted-foreground bg-muted/50 px-3 py-2 rounded-md">
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
                      {header.column.getCanSort() &&
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
                  No hay instalaciones con audio.
                  {isEditor &&
                    ' Usa "Escanear Todo" para buscar archivos.'}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <Fragment key={row.id}>
                  <TableRow
                    className={`cursor-pointer hover:bg-muted/50 ${row.getIsExpanded() ? "bg-primary/10 border-b-0" : ""}`}
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
                      <TableCell colSpan={columns.length} className="p-0">
                        <AudioExpandedRow
                          deployment={row.original}
                          isEditor={isEditor}
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
          {(globalFilter || projectFilter) && " (filtradas)"}
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
    </div>
  );
}
