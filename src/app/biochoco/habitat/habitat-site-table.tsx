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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Camera,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Search,
} from "lucide-react";
import { getHabitatName } from "../overview/types";
import type { HabitatAssessment } from "./types";
import {
  HABITAT_COLORS,
  HEIGHT_CLASS_LABELS,
  UNDERSTORY_LABELS,
  SLOPE_LABELS,
  DISTURBANCE_LABELS,
} from "./types";

function formatDisturbance(signs: string): string {
  if (!signs || signs === "none") return "—";
  return signs
    .split(/\s+/)
    .map((d) => DISTURBANCE_LABELS[d] ?? d)
    .join(", ");
}

function hasPhotos(a: HabitatAssessment): boolean {
  return !!(
    a.photoNorth ||
    a.photoEast ||
    a.photoSouth ||
    a.photoWest ||
    a.photoCanopy
  );
}

interface HabitatSiteTableProps {
  assessments: HabitatAssessment[];
  onViewPhotos: (assessment: HabitatAssessment) => void;
}

export function HabitatSiteTable({
  assessments,
  onViewPhotos,
}: HabitatSiteTableProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 50,
  });

  const columns = useMemo<ColumnDef<HabitatAssessment>[]>(
    () => [
      {
        id: "photos",
        header: "",
        cell: ({ row }) => {
          const a = row.original;
          if (!hasPhotos(a)) return null;
          return (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 gap-1"
              onClick={() => onViewPhotos(a)}
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
        accessorKey: "siteId",
        header: "Sitio",
      },
      {
        accessorKey: "habitatType",
        header: "Hábitat",
        cell: ({ getValue }) => {
          const ht = getValue<string>();
          return (
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                style={{
                  backgroundColor: HABITAT_COLORS[ht] ?? "#9E9E9E",
                }}
              />
              {getHabitatName(ht)}
            </span>
          );
        },
        filterFn: (row, _columnId, filterValue: string) => {
          const ht = row.getValue<string>("habitatType");
          const name = getHabitatName(ht).toLowerCase();
          return name.includes(filterValue.toLowerCase());
        },
      },
      {
        accessorKey: "assessmentDate",
        header: "Fecha",
      },
      {
        accessorKey: "canopyCoverPercent",
        header: "Dosel %",
        cell: ({ getValue }) => (
          <span className="tabular-nums">
            {getValue<number>().toFixed(1)}
          </span>
        ),
      },
      {
        accessorKey: "canopyHeightClass",
        header: "Altura",
        cell: ({ getValue }) => {
          const val = getValue<string>();
          return HEIGHT_CLASS_LABELS[val] ?? val;
        },
        filterFn: (row, _columnId, filterValue: string) => {
          const val = row.getValue<string>("canopyHeightClass");
          const label = (HEIGHT_CLASS_LABELS[val] ?? val).toLowerCase();
          return label.includes(filterValue.toLowerCase());
        },
      },
      {
        accessorKey: "treesMedium",
        header: "Árb. Med",
        cell: ({ getValue }) => (
          <span className="tabular-nums">{getValue<number>()}</span>
        ),
      },
      {
        accessorKey: "treesLarge",
        header: "Árb. Gran",
        cell: ({ getValue }) => (
          <span className="tabular-nums">{getValue<number>()}</span>
        ),
      },
      {
        accessorKey: "understoryDensity",
        header: "Sotobosque",
        cell: ({ getValue }) => {
          const val = getValue<string>();
          return UNDERSTORY_LABELS[val] ?? val;
        },
        filterFn: (row, _columnId, filterValue: string) => {
          const val = row.getValue<string>("understoryDensity");
          const label = (UNDERSTORY_LABELS[val] ?? val).toLowerCase();
          return label.includes(filterValue.toLowerCase());
        },
      },
      {
        accessorKey: "slopeCategory",
        header: "Pendiente",
        cell: ({ getValue }) => {
          const val = getValue<string>();
          return SLOPE_LABELS[val] ?? val;
        },
        filterFn: (row, _columnId, filterValue: string) => {
          const val = row.getValue<string>("slopeCategory");
          const label = (SLOPE_LABELS[val] ?? val).toLowerCase();
          return label.includes(filterValue.toLowerCase());
        },
      },
      {
        accessorKey: "disturbanceSigns",
        header: "Perturbación",
        cell: ({ getValue }) => formatDisturbance(getValue<string>()),
        filterFn: (row, _columnId, filterValue: string) => {
          const val = row.getValue<string>("disturbanceSigns");
          const formatted = formatDisturbance(val).toLowerCase();
          return formatted.includes(filterValue.toLowerCase());
        },
      },
    ],
    [onViewPhotos]
  );

  const table = useReactTable({
    data: assessments,
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

  if (assessments.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No hay evaluaciones registradas
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="relative max-w-sm">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Buscar en la tabla..."
          value={globalFilter}
          onChange={(e) => setGlobalFilter(e.target.value)}
          className="pl-9"
        />
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
