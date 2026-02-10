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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Download,
  Search,
} from "lucide-react";
import type { BudgetRow } from "./actions";

function formatCurrency(val: number) {
  return (
    "$" +
    val.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

const columns: ColumnDef<BudgetRow>[] = [
  {
    accessorKey: "category",
    header: "Categoria",
    size: 250,
  },
  {
    accessorKey: "spent",
    header: "Gastado",
    size: 130,
    cell: ({ getValue }) => (
      <span className="tabular-nums">{formatCurrency(getValue<number>())}</span>
    ),
  },
  {
    accessorKey: "budgetedProrated",
    header: "Presupuesto Prorrateado",
    size: 180,
    cell: ({ getValue }) => (
      <span className="tabular-nums">{formatCurrency(getValue<number>())}</span>
    ),
  },
  {
    accessorKey: "progress",
    header: "Progreso",
    size: 180,
    cell: ({ getValue }) => {
      const progress = getValue<number>();
      const pct = Math.round(progress * 100);
      const isOver = progress > 1;
      // Cap at 100 for the progress bar visual, but show real % in text
      const barValue = Math.min(pct, 100);

      return (
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-[80px]">
            <Progress
              value={barValue}
              className={isOver ? "[&>[data-slot=progress-indicator]]:bg-red-500" : "[&>[data-slot=progress-indicator]]:bg-green-500"}
            />
          </div>
          <span
            className={`tabular-nums text-xs font-medium whitespace-nowrap ${
              isOver ? "text-red-600" : "text-muted-foreground"
            }`}
          >
            {pct}%
          </span>
        </div>
      );
    },
    sortingFn: "basic",
  },
  {
    accessorKey: "budgetedAnnual",
    header: "Presupuesto Anual",
    size: 160,
    cell: ({ getValue }) => (
      <span className="tabular-nums">{formatCurrency(getValue<number>())}</span>
    ),
  },
];

export function BudgetTable({ rows }: { rows: BudgetRow[] }) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    initialState: { pagination: { pageSize: 50 } },
  });

  const downloadCsv = useMemo(() => {
    return () => {
      const filteredRows = table.getFilteredRowModel().rows;
      const headers = [
        "Categoria",
        "Gastado",
        "Presupuesto Prorrateado",
        "Progreso %",
        "Presupuesto Anual",
      ].join(",");
      const csvRows = filteredRows.map((row) => {
        const data = row.original;
        return [
          data.category.includes(",") ? `"${data.category}"` : data.category,
          data.spent.toFixed(2),
          data.budgetedProrated.toFixed(2),
          (data.progress * 100).toFixed(1),
          data.budgetedAnnual.toFixed(2),
        ].join(",");
      });
      const csv = "\uFEFF" + [headers, ...csvRows].join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "presupuesto.csv";
      a.click();
      URL.revokeObjectURL(url);
    };
  }, [table]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">
            Comparacion de Presupuesto
          </CardTitle>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Buscar..."
                value={globalFilter}
                onChange={(e) => setGlobalFilter(e.target.value)}
                className="pl-8 w-64"
              />
            </div>
            <Button variant="outline" size="sm" onClick={downloadCsv}>
              <Download className="h-4 w-4 mr-1" />
              CSV
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((hg) => (
                <TableRow key={hg.id}>
                  {hg.headers.map((h) => (
                    <TableHead
                      key={h.id}
                      className="cursor-pointer select-none whitespace-nowrap"
                      onClick={h.column.getToggleSortingHandler()}
                    >
                      <div className="flex items-center gap-1">
                        {flexRender(
                          h.column.columnDef.header,
                          h.getContext()
                        )}
                        {h.column.getIsSorted() === "asc" ? (
                          <ArrowUp className="h-3.5 w-3.5" />
                        ) : h.column.getIsSorted() === "desc" ? (
                          <ArrowDown className="h-3.5 w-3.5" />
                        ) : (
                          <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                      </div>
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
                    className="text-center py-8 text-muted-foreground"
                  >
                    No hay registros que coincidan
                  </TableCell>
                </TableRow>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id} className="whitespace-nowrap">
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
        <div className="flex items-center justify-between mt-4 text-sm text-muted-foreground">
          <span>
            Pagina {table.getState().pagination.pageIndex + 1} de{" "}
            {table.getPageCount()} ({table.getFilteredRowModel().rows.length}{" "}
            registros)
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => table.setPageIndex(0)}
              disabled={!table.getCanPreviousPage()}
            >
              <ChevronsLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => table.setPageIndex(table.getPageCount() - 1)}
              disabled={!table.getCanNextPage()}
            >
              <ChevronsRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
