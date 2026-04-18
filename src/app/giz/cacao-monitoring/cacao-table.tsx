"use client";

import { useState, useMemo } from "react";
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
} from "@tanstack/react-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SortIcon } from "@/components/sort-icon";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Download,
  Search,
} from "lucide-react";
import type { CacaoRecord } from "@/lib/odk-types";

function survivalBadge(rate: number | null) {
  if (rate == null) return <span className="text-muted-foreground">—</span>;
  const variant = rate >= 80 ? "default" : rate >= 50 ? "secondary" : "destructive";
  return <Badge variant={variant}>{rate.toFixed(1)}%</Badge>;
}

function downloadCsv(records: CacaoRecord[]) {
  const headers = [
    "Código Finca",
    "Propietario",
    "Comunidad",
    "Fecha Monitoreo",
    "Fecha Siembra",
    "Plantas Sembradas",
    "Plantas Vivas",
    "% Supervivencia",
    "Limpiezas",
    "Fertilizado",
    "Notas",
  ];

  const rows = records.map((r) => [
    r.farmCode,
    r.ownerName,
    r.community,
    r.monitoringDate ?? "",
    r.plantingDate ?? "",
    r.plantsPlanted?.toString() ?? "",
    r.plantsAlive?.toString() ?? "",
    r.survivalRate?.toString() ?? "",
    r.numCleanings?.toString() ?? "",
    r.fertilized ?? "",
    r.monitorNotes ?? "",
  ]);

  const csvContent = [
    headers.join(","),
    ...rows.map((row) =>
      row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",")
    ),
  ].join("\n");

  const blob = new Blob(["\uFEFF" + csvContent], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `monitoreo_cacao_${new Date().toISOString().split("T")[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function CacaoTable({ records }: { records: CacaoRecord[] }) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 50,
  });

  const columns = useMemo<ColumnDef<CacaoRecord>[]>(
    () => [
      { accessorKey: "farmCode", header: "Código Finca" },
      { accessorKey: "ownerName", header: "Propietario" },
      { accessorKey: "community", header: "Comunidad" },
      {
        accessorKey: "monitoringDate",
        header: "Fecha Monitoreo",
        cell: ({ getValue }) => getValue<string | null>() ?? "—",
      },
      {
        accessorKey: "plantsPlanted",
        header: "Sembradas",
        cell: ({ getValue }) => (
          <span className="tabular-nums">{getValue<number | null>() ?? "—"}</span>
        ),
      },
      {
        accessorKey: "plantsAlive",
        header: "Vivas",
        cell: ({ getValue }) => (
          <span className="tabular-nums">{getValue<number | null>() ?? "—"}</span>
        ),
      },
      {
        accessorKey: "survivalRate",
        header: "% Supervivencia",
        cell: ({ getValue }) => survivalBadge(getValue<number | null>()),
      },
      {
        accessorKey: "numCleanings",
        header: "Limpiezas",
        cell: ({ getValue }) => (
          <span className="tabular-nums">{getValue<number | null>() ?? "—"}</span>
        ),
      },
      {
        accessorKey: "fertilized",
        header: "Fertilizado",
        cell: ({ getValue }) => getValue<string | null>() ?? "—",
      },
    ],
    []
  );

  const table = useReactTable({
    data: records,
    columns,
    state: { sorting, globalFilter, pagination },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar en la tabla..."
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="pl-9"
          />
        </div>
        <Button variant="outline" size="sm" onClick={() => downloadCsv(records)}>
          <Download className="h-4 w-4 mr-1.5" />
          CSV
        </Button>
      </div>

      <div className="rounded-xl border overflow-auto">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className={
                      header.column.getCanSort() ? "cursor-pointer select-none" : ""
                    }
                    onClick={header.column.getToggleSortingHandler()}
                  >
                    <span className="flex items-center gap-1">
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
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
            {table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="text-center text-muted-foreground py-8"
                >
                  No hay registros que coincidan
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-sm">
        <p className="text-muted-foreground">
          {table.getFilteredRowModel().rows.length} registros
          {globalFilter && " (filtrados)"}
        </p>
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="sm" className="h-8 w-8 p-0" onClick={() => table.firstPage()} disabled={!table.getCanPreviousPage()}>
            <ChevronsLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" className="h-8 w-8 p-0" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="px-2 text-muted-foreground">
            {table.getState().pagination.pageIndex + 1} / {table.getPageCount()}
          </span>
          <Button variant="outline" size="sm" className="h-8 w-8 p-0" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" className="h-8 w-8 p-0" onClick={() => table.lastPage()} disabled={!table.getCanNextPage()}>
            <ChevronsRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
