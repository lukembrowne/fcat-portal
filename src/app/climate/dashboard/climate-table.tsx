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
import { SortIcon } from "@/components/sort-icon";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Download,
  Loader2,
  Pencil,
  X,
} from "lucide-react";
import {
  fetchClimateTablePage,
  fetchClimateExportData,
  nullClimateValue,
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

// Map camelCase field → snake_case DB column for nullClimateValue
const FIELD_TO_COLUMN: Record<string, string> = {
  airTempAvg: "air_temp_avg",
  airTempMax: "air_temp_max",
  airTempMin: "air_temp_min",
  humidityAvg: "humidity_avg",
  rainMm: "rain_mm",
  solarAvg: "solar_avg",
  windSpeedAvg: "wind_speed_avg",
  windDirAvg: "wind_dir_avg",
  pressureAvg: "pressure_avg",
};

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

// Map accessor key to the camelCase field on TableRow_
const ACCESSOR_TO_FIELD: Record<string, keyof TableRow_> = {
  air_temp_avg: "airTempAvg",
  air_temp_max: "airTempMax",
  air_temp_min: "airTempMin",
  humidity_avg: "humidityAvg",
  rain_mm: "rainMm",
  solar_avg: "solarAvg",
  wind_speed_avg: "windSpeedAvg",
  wind_dir_avg: "windDirAvg",
  pressure_avg: "pressureAvg",
};

interface ClimateTableProps {
  filters: ClimateFilters;
  canEdit?: boolean;
}

export function ClimateTable({ filters, canEdit = false }: ClimateTableProps) {
  const [rows, setRows] = useState<TableRow_[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [sortColumn, setSortColumn] = useState<ClimateSortColumn>("timestamp");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [nulling, setNulling] = useState<string | null>(null); // "rowIdx:field" key of cell being nulled

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

  async function handleNullCell(rowIdx: number, accessorKey: string) {
    const field = ACCESSOR_TO_FIELD[accessorKey];
    if (!field) return;

    const row = rows[rowIdx];
    if (!row || row[field] === null) return;

    const dbColumn = FIELD_TO_COLUMN[field];
    if (!dbColumn) return;

    const cellKey = `${rowIdx}:${field}`;
    setNulling(cellKey);

    const result = await nullClimateValue({
      timestamp: row.timestamp,
      resolution: filters.resolution,
      column: dbColumn,
    });

    if (result.success) {
      // Update local state
      setRows((prev) =>
        prev.map((r, i) =>
          i === rowIdx ? { ...r, [field]: null } : r
        )
      );
    }
    setNulling(null);
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
    const direction =
      serverCol && sortColumn === serverCol ? sortDir : false;
    return <SortIcon direction={direction} />;
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Registros</CardTitle>
          <div className="flex items-center gap-2">
            {canEdit && (
              <Button
                variant={editMode ? "default" : "outline"}
                size="sm"
                onClick={() => setEditMode(!editMode)}
              >
                {editMode ? (
                  <>
                    <X className="h-4 w-4 mr-1" />
                    Salir de edición
                  </>
                ) : (
                  <>
                    <Pencil className="h-4 w-4 mr-1" />
                    Editar
                  </>
                )}
              </Button>
            )}
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
        </div>
        {editMode && (
          <p className="text-xs text-muted-foreground mt-1">
            Haz clic en un valor para convertirlo a NULL. Los cambios se registran en el historial de ediciones.
          </p>
        )}
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
                    {row.getVisibleCells().map((cell) => {
                      const accessorKey = (cell.column.columnDef as { accessorKey?: string }).accessorKey;
                      const field = accessorKey ? ACCESSOR_TO_FIELD[accessorKey] : undefined;
                      const isEditable = editMode && field && accessorKey !== "timestamp";
                      const cellValue = field ? row.original[field] : null;
                      const cellKey = `${row.index}:${field}`;
                      const isNulling = nulling === cellKey;

                      return (
                        <TableCell
                          key={cell.id}
                          className={`whitespace-nowrap ${
                            isEditable && cellValue !== null
                              ? "cursor-pointer hover:bg-destructive/10 transition-colors"
                              : ""
                          }`}
                          onClick={
                            isEditable && cellValue !== null && !isNulling
                              ? () => handleNullCell(row.index, accessorKey!)
                              : undefined
                          }
                          title={isEditable && cellValue !== null ? "Clic para convertir a NULL" : undefined}
                        >
                          {isNulling ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                          ) : (
                            flexRender(cell.column.columnDef.cell, cell.getContext())
                          )}
                        </TableCell>
                      );
                    })}
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
