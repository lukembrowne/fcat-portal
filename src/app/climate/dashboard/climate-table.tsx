"use client";

import { useState, useEffect, useCallback } from "react";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type ColumnDef,
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Download,
  Loader2,
} from "lucide-react";
import {
  fetchClimateTablePage,
  fetchClimateExportData,
  type ClimateFilters,
  type ClimateSortColumn,
} from "./actions";

interface TableRow_ {
  timestamp: string;
  airTempAvg: number | null;
  airTempMax: number | null;
  airTempMin: number | null;
  humidityAvg: number | null;
  rainMm: number | null;
  solarAvg: number | null;
  windSpeedAvg: number | null;
  windDirAvg: number | null;
  pressureAvg: number | null;
}

function fmtNum(val: number | null, decimals = 1): string {
  if (val === null || val === undefined) return "--";
  return val.toFixed(decimals);
}

const PAGE_SIZE = 50;

const columns: ColumnDef<TableRow_>[] = [
  {
    accessorKey: "timestamp",
    header: "Fecha/Hora",
    size: 160,
    cell: ({ getValue }) => (
      <span className="tabular-nums">{getValue<string>()}</span>
    ),
  },
  {
    accessorKey: "air_temp_avg",
    header: "Temp (°C)",
    size: 90,
    cell: ({ row }) => (
      <span className="tabular-nums">{fmtNum(row.original.airTempAvg)}</span>
    ),
  },
  {
    accessorKey: "air_temp_max",
    header: "Temp Máx",
    size: 90,
    cell: ({ row }) => (
      <span className="tabular-nums">{fmtNum(row.original.airTempMax)}</span>
    ),
  },
  {
    accessorKey: "air_temp_min",
    header: "Temp Mín",
    size: 90,
    cell: ({ row }) => (
      <span className="tabular-nums">{fmtNum(row.original.airTempMin)}</span>
    ),
  },
  {
    accessorKey: "humidity_avg",
    header: "Humedad (%)",
    size: 100,
    cell: ({ row }) => (
      <span className="tabular-nums">{fmtNum(row.original.humidityAvg)}</span>
    ),
  },
  {
    accessorKey: "rain_mm",
    header: "Lluvia (mm)",
    size: 100,
    cell: ({ row }) => (
      <span className="tabular-nums">{fmtNum(row.original.rainMm)}</span>
    ),
  },
  {
    accessorKey: "solar_avg",
    header: "Solar (W/m²)",
    size: 110,
    cell: ({ row }) => (
      <span className="tabular-nums">{fmtNum(row.original.solarAvg)}</span>
    ),
  },
  {
    accessorKey: "wind_speed_avg",
    header: "Viento (m/s)",
    size: 100,
    cell: ({ row }) => (
      <span className="tabular-nums">{fmtNum(row.original.windSpeedAvg, 2)}</span>
    ),
  },
  {
    accessorKey: "wind_dir_avg",
    header: "Dir. Viento",
    size: 100,
    cell: ({ row }) => (
      <span className="tabular-nums">{fmtNum(row.original.windDirAvg, 0)}</span>
    ),
  },
  {
    accessorKey: "pressure_avg",
    header: "Presión",
    size: 90,
    cell: ({ row }) => (
      <span className="tabular-nums">{fmtNum(row.original.pressureAvg)}</span>
    ),
  },
];

// Map column accessorKey to server sort column name
const SORT_MAP: Record<string, ClimateSortColumn> = {
  timestamp: "timestamp",
  air_temp_avg: "air_temp_avg",
  air_temp_max: "air_temp_max",
  air_temp_min: "air_temp_min",
  humidity_avg: "humidity_avg",
  rain_mm: "rain_mm",
  solar_avg: "solar_avg",
  wind_speed_avg: "wind_speed_avg",
  pressure_avg: "pressure_avg",
};

interface ClimateTableProps {
  filters: ClimateFilters;
}

export function ClimateTable({ filters }: ClimateTableProps) {
  const [rows, setRows] = useState<TableRow_[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [sortColumn, setSortColumn] = useState<ClimateSortColumn>("timestamp");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [filters.dateStart, filters.dateEnd, filters.resolution]);

  const loadPage = useCallback(async () => {
    setLoading(true);
    const result = await fetchClimateTablePage({
      filters,
      page,
      pageSize: PAGE_SIZE,
      sortColumn,
      sortDirection: sortDir,
    });
    if (result.success) {
      setRows(result.data.rows);
      setTotalCount(result.data.totalCount);
    }
    setLoading(false);
  }, [filters, page, sortColumn, sortDir]);

  useEffect(() => {
    loadPage();
  }, [loadPage]);

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    pageCount: totalPages,
  });

  function handleSort(accessorKey: string) {
    const serverCol = SORT_MAP[accessorKey];
    if (!serverCol) return;

    if (sortColumn === serverCol) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortColumn(serverCol);
      setSortDir("desc");
    }
    setPage(1);
  }

  async function handleExportCsv() {
    setExporting(true);
    const result = await fetchClimateExportData(filters);
    if (result.success) {
      const data = result.data.rows;
      if (data.length === 0) {
        setExporting(false);
        return;
      }
      const headers = Object.keys(data[0]);
      const csvRows = data.map((row) =>
        headers
          .map((h) => {
            const val = row[h];
            const str = val == null ? "" : String(val);
            return `"${str.replace(/"/g, '""')}"`;
          })
          .join(",")
      );
      const csv = "\uFEFF" + [headers.join(","), ...csvRows].join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `datos_climaticos_${filters.resolution}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    }
    setExporting(false);
  }

  // Get current sort state for a column
  function getSortIcon(accessorKey: string) {
    const serverCol = SORT_MAP[accessorKey];
    if (!serverCol || sortColumn !== serverCol) {
      return <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />;
    }
    return sortDir === "asc" ? (
      <ArrowUp className="h-3.5 w-3.5" />
    ) : (
      <ArrowDown className="h-3.5 w-3.5" />
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Registros</CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportCsv}
            disabled={exporting || totalCount === 0}
          >
            {exporting ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Download className="h-4 w-4 mr-1" />
            )}
            CSV ({totalCount.toLocaleString()} filas)
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((hg) => (
                <TableRow key={hg.id}>
                  {hg.headers.map((h) => {
                    const accessorKey = (h.column.columnDef as { accessorKey?: string }).accessorKey;
                    const sortable = accessorKey && accessorKey in SORT_MAP;
                    return (
                      <TableHead
                        key={h.id}
                        className={sortable ? "cursor-pointer select-none whitespace-nowrap" : "whitespace-nowrap"}
                        onClick={sortable ? () => handleSort(accessorKey) : undefined}
                      >
                        <div className="flex items-center gap-1">
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {sortable && getSortIcon(accessorKey)}
                        </div>
                      </TableHead>
                    );
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={columns.length} className="text-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin mx-auto text-muted-foreground" />
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={columns.length}
                    className="text-center py-8 text-muted-foreground"
                  >
                    No hay registros para el período seleccionado
                  </TableCell>
                </TableRow>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id} className="whitespace-nowrap">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
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
            Página {page} de {totalPages} ({totalCount.toLocaleString()} registros)
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => setPage(1)}
              disabled={page <= 1}
            >
              <ChevronsLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => setPage((p) => p - 1)}
              disabled={page <= 1}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => setPage((p) => p + 1)}
              disabled={page >= totalPages}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => setPage(totalPages)}
              disabled={page >= totalPages}
            >
              <ChevronsRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
