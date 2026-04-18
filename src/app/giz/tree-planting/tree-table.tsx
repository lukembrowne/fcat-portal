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
  Camera,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Download,
  Search,
} from "lucide-react";
import type { TreeRecord } from "@/lib/odk-types";

function conditionVariant(c: string) {
  switch (c) {
    case "excelente":
      return "default" as const;
    case "regular":
      return "secondary" as const;
    case "mala":
      return "destructive" as const;
    default:
      return "outline" as const;
  }
}

function survivalVariant(s: string) {
  switch (s) {
    case "vivo":
      return "default" as const;
    case "muerto":
      return "destructive" as const;
    default:
      return "outline" as const;
  }
}

function downloadCsv(trees: TreeRecord[]) {
  const headers = [
    "Código",
    "Fecha",
    "Finca",
    "Dueño",
    "Especie",
    "Altura (cm)",
    "Condición",
    "Supervivencia",
    "Extensionista",
    "Notas",
    "Latitud",
    "Longitud",
  ];

  const rows = trees.map((t) => [
    t.code,
    t.date ?? "",
    t.farm,
    t.owner,
    t.species,
    t.height?.toString() ?? "",
    t.condition,
    t.survival,
    t.worker,
    t.notes,
    t.lat?.toString() ?? "",
    t.lng?.toString() ?? "",
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
  a.download = `siembra_arboles_${new Date().toISOString().split("T")[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

interface TreeTableProps {
  trees: TreeRecord[];
  onViewPhotos: (tree: TreeRecord) => void;
}

export function TreeTable({ trees, onViewPhotos }: TreeTableProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 50,
  });

  const columns = useMemo<ColumnDef<TreeRecord>[]>(
    () => [
      {
        id: "photos",
        header: "",
        cell: ({ row }) => {
          const t = row.original;
          const hasPhotos = t.photoTop || t.photoSide || t.photoLeaf;
          if (!hasPhotos) return null;
          return (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 gap-1"
              onClick={() => onViewPhotos(t)}
            >
              <Camera className="h-4 w-4" />
              <span className="text-xs">Ver Fotos</span>
            </Button>
          );
        },
        enableSorting: false,
        enableGlobalFilter: false,
        size: 100,
      },
      {
        accessorKey: "code",
        header: "Código",
      },
      {
        accessorKey: "date",
        header: "Fecha",
        cell: ({ getValue }) => getValue<string | null>() ?? "—",
      },
      {
        accessorKey: "farm",
        header: "Finca",
      },
      {
        accessorKey: "species",
        header: "Especie",
      },
      {
        accessorKey: "height",
        header: "Altura (cm)",
        cell: ({ getValue }) => (
          <span className="tabular-nums">
            {getValue<number | null>() ?? "—"}
          </span>
        ),
      },
      {
        accessorKey: "condition",
        header: "Condición",
        cell: ({ getValue }) => {
          const val = getValue<string>();
          return val ? (
            <Badge variant={conditionVariant(val)}>{val}</Badge>
          ) : (
            "—"
          );
        },
      },
      {
        accessorKey: "survival",
        header: "Supervivencia",
        cell: ({ getValue }) => {
          const val = getValue<string>();
          return val ? (
            <Badge variant={survivalVariant(val)}>{val}</Badge>
          ) : (
            "—"
          );
        },
      },
      {
        accessorKey: "worker",
        header: "Extensionista",
      },
    ],
    [onViewPhotos]
  );

  const table = useReactTable({
    data: trees,
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
        <Button variant="outline" size="sm" onClick={() => downloadCsv(trees)}>
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

      <div className="flex items-center justify-between text-sm">
        <p className="text-muted-foreground">
          {table.getFilteredRowModel().rows.length} registros
          {globalFilter && " (filtrados)"}
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
            {table.getState().pagination.pageIndex + 1} / {table.getPageCount()}
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
