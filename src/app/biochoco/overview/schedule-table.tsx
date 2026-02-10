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
import {
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Search,
  ExternalLink,
} from "lucide-react";
import type { ScheduleRow } from "@/lib/schedule-types";
import type { SiteInfo } from "./types";
import { getHabitatName, getDeploymentStatus, SPANISH_MONTHS } from "./types";

interface ScheduleTableProps {
  deploymentsThisMonth: ScheduleRow[];
  retrievalsThisMonth: ScheduleRow[];
  allSchedule: ScheduleRow[];
  sites: SiteInfo[];
  deployedSet: Set<string>;
  retrievedSet: Set<string>;
  selectedMonth: { year: number; month: number };
}

interface CombinedRow {
  date: string;
  type: "deploy" | "retrieve";
  siteId: string;
  siteName: string;
  habitat: string;
  habitatAssessed: string;
  deploymentId: string;
  status: "scheduled" | "deployed" | "retrieved";
  lat: number | null;
  lng: number | null;
  driveFolderLink: string;
}

function statusBadge(status: string) {
  switch (status) {
    case "retrieved":
      return <Badge variant="secondary">Recuperado</Badge>;
    case "deployed":
      return <Badge variant="default">Instalado</Badge>;
    default:
      return <Badge variant="outline">Programado</Badge>;
  }
}

function isRowComplete(row: CombinedRow): boolean {
  if (row.type === "deploy") {
    return row.status === "deployed" || row.status === "retrieved";
  }
  // retrieve type
  return row.status === "retrieved";
}

function buildArcGISUrl(lat: number, lng: number): string {
  return `https://enlace-eliminado/apps/mapviewer/index.html?configurableview=true&webmap=webmap-id-eliminado&theme=light&heading=true&legend=true&share=true&center=${lng},${lat}&scale=5000`;
}

function buildRows(
  scheduleRows: ScheduleRow[],
  type: "deploy" | "retrieve",
  siteMap: Map<string, SiteInfo>,
  deployedSet: Set<string>,
  retrievedSet: Set<string>,
): CombinedRow[] {
  return scheduleRows.map((r) => {
    const site = siteMap.get(r.siteId);
    return {
      date: type === "deploy" ? (r.plannedDeployDate ?? "") : (r.plannedRetrieveDate ?? ""),
      type,
      siteId: r.siteId,
      siteName: r.siteName,
      habitat: getHabitatName(r.habitatType),
      habitatAssessed: site?.habitatAssessed ?? "",
      deploymentId: r.deploymentId,
      status: getDeploymentStatus(r.deploymentId, deployedSet, retrievedSet),
      lat: site?.lat ?? null,
      lng: site?.lng ?? null,
      driveFolderLink: r.driveFolderLink,
    };
  });
}

export function ScheduleTable({
  deploymentsThisMonth,
  retrievalsThisMonth,
  allSchedule,
  sites,
  deployedSet,
  retrievedSet,
  selectedMonth,
}: ScheduleTableProps) {
  const [showAll, setShowAll] = useState(false);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 50,
  });

  const monthLabel = `${SPANISH_MONTHS[selectedMonth.month]} ${selectedMonth.year}`;

  const siteMap = useMemo(() => {
    const map = new Map<string, SiteInfo>();
    for (const s of sites) map.set(s.siteId, s);
    return map;
  }, [sites]);

  const rows = useMemo<CombinedRow[]>(() => {
    if (showAll) {
      // Show all schedule rows — each row appears once for deploy and once for retrieve
      const combined: CombinedRow[] = [
        ...buildRows(allSchedule, "deploy", siteMap, deployedSet, retrievedSet),
        ...buildRows(
          allSchedule.filter((r) => r.plannedRetrieveDate),
          "retrieve",
          siteMap,
          deployedSet,
          retrievedSet,
        ),
      ];
      return combined.sort((a, b) => a.date.localeCompare(b.date));
    }

    const combined: CombinedRow[] = [
      ...buildRows(deploymentsThisMonth, "deploy", siteMap, deployedSet, retrievedSet),
      ...buildRows(retrievalsThisMonth, "retrieve", siteMap, deployedSet, retrievedSet),
    ];
    return combined.sort((a, b) => a.date.localeCompare(b.date));
  }, [showAll, allSchedule, deploymentsThisMonth, retrievalsThisMonth, siteMap, deployedSet, retrievedSet]);

  const columns = useMemo<ColumnDef<CombinedRow>[]>(
    () => [
      {
        accessorKey: "date",
        header: "Fecha",
        cell: ({ getValue }) => (
          <span className="tabular-nums">{getValue<string>() || "—"}</span>
        ),
      },
      {
        accessorKey: "type",
        header: "Tipo",
        cell: ({ getValue }) => {
          const v = getValue<string>();
          return (
            <span className={v === "deploy" ? "text-green-600 font-medium" : "text-orange-600 font-medium"}>
              {v === "deploy" ? "Instalación" : "Recuperación"}
            </span>
          );
        },
      },
      {
        accessorKey: "siteId",
        header: "ID Sitio",
      },
      {
        accessorKey: "siteName",
        header: "Nombre",
      },
      {
        accessorKey: "habitat",
        header: "Hábitat",
      },
      {
        accessorKey: "habitatAssessed",
        header: "Habitat Evaluado",
        cell: ({ getValue }) => getValue<string>() || "—",
      },
      {
        accessorKey: "deploymentId",
        header: "ID Instalación",
        cell: ({ getValue }) => (
          <span className="font-mono text-xs">{getValue<string>()}</span>
        ),
      },
      {
        id: "status",
        accessorKey: "status",
        header: "Estado",
        cell: ({ getValue }) => statusBadge(getValue<string>()),
      },
      {
        accessorKey: "lat",
        header: "Latitud",
        cell: ({ getValue }) => {
          const v = getValue<number | null>();
          return v != null ? <span className="tabular-nums">{v.toFixed(5)}</span> : "—";
        },
        enableGlobalFilter: false,
      },
      {
        accessorKey: "lng",
        header: "Longitud",
        cell: ({ getValue }) => {
          const v = getValue<number | null>();
          return v != null ? <span className="tabular-nums">{v.toFixed(5)}</span> : "—";
        },
        enableGlobalFilter: false,
      },
      {
        id: "map",
        header: "Mapa",
        cell: ({ row }) => {
          const { lat, lng } = row.original;
          if (lat == null || lng == null) return "—";
          return (
            <a
              href={buildArcGISUrl(lat, lng)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-blue-600 hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Ver
            </a>
          );
        },
        enableSorting: false,
        enableGlobalFilter: false,
      },
      {
        id: "carpeta",
        header: "Carpeta",
        cell: ({ row }) => {
          const link = row.original.driveFolderLink;
          if (!link) return "—";
          return (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-blue-600 hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Abrir
            </a>
          );
        },
        enableSorting: false,
        enableGlobalFilter: false,
      },
    ],
    [],
  );

  const table = useReactTable({
    data: rows,
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
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">
          {showAll ? "Cronograma — Todo el cronograma" : `Cronograma — ${monthLabel}`}
        </h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setShowAll((v) => !v);
            setPagination((p) => ({ ...p, pageIndex: 0 }));
          }}
        >
          {showAll ? "Este mes" : "Todo el cronograma"}
        </Button>
      </div>

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
                              header.getContext(),
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
                    {showAll
                      ? "No hay actividades en el cronograma."
                      : "No hay actividades programadas este mes."}
                  </TableCell>
                </TableRow>
              ) : (
                table.getRowModel().rows.map((row) => {
                  const complete = isRowComplete(row.original);
                  return (
                    <TableRow
                      key={row.id}
                      className={complete ? "bg-green-50" : "bg-amber-50"}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id}>
                          {flexRender(
                            cell.column.columnDef.cell,
                            cell.getContext(),
                          )}
                        </TableCell>
                      ))}
                    </TableRow>
                  );
                })
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
    </section>
  );
}
