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
  MapPin,
  Download,
} from "lucide-react";
import type { ScheduleRow } from "@/lib/schedule-types";
import type { SiteInfo } from "./types";
import { getHabitatName, getDeploymentStatus, SPANISH_MONTHS } from "./types";
import { toUtm17N } from "@/lib/utm";
import { FieldNotesPopover } from "@/app/biochoco/field-notes/field-notes-popover";

interface ScheduleTableProps {
  deploymentsThisMonth: ScheduleRow[];
  retrievalsThisMonth: ScheduleRow[];
  allSchedule: ScheduleRow[];
  sites: SiteInfo[];
  deployedSet: Set<string>;
  retrievedSet: Set<string>;
  selectedMonth: { year: number; month: number };
  canEditNotes?: boolean;
  onFocusSite?: (lat: number, lng: number) => void;
  onPrevMonth?: () => void;
  onNextMonth?: () => void;
}

interface CombinedRow {
  date: string;
  actualDate: string;
  type: "deploy" | "retrieve";
  siteId: string;
  siteName: string;
  habitat: string;
  deploymentId: string;
  status: "scheduled" | "deployed" | "retrieved";
  lat: number | null;
  lng: number | null;
  driveFolderLink: string;
  fieldNotes: string | null;
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
      actualDate: type === "deploy" ? (r.actualDeployDate ?? "") : (r.actualRetrieveDate ?? ""),
      type,
      siteId: r.siteId,
      siteName: r.siteName,
      habitat: getHabitatName(r.habitatType),
      deploymentId: r.deploymentId,
      status: getDeploymentStatus(r.deploymentId, deployedSet, retrievedSet),
      lat: site?.lat ?? null,
      lng: site?.lng ?? null,
      driveFolderLink: r.driveFolderLink,
      fieldNotes: r.fieldNotes ?? null,
    };
  });
}

function downloadCsv(rows: CombinedRow[]) {
  const headers = [
    "Fecha Plan",
    "Fecha Real",
    "Tipo",
    "ID Sitio",
    "Nombre",
    "Hábitat",
    "ID Instalación",
    "Notas de campo",
    "Estado",
    "Latitud",
    "Longitud",
    "UTM Este",
    "UTM Norte",
  ];

  const statusLabel: Record<string, string> = {
    scheduled: "Programado",
    deployed: "Instalado",
    retrieved: "Recuperado",
  };

  const csvRows = rows.map((r) => {
    let utmE = "";
    let utmN = "";
    if (r.lat != null && r.lng != null) {
      const utm = toUtm17N(r.lat, r.lng);
      utmE = Math.round(utm.easting).toString();
      utmN = Math.round(utm.northing).toString();
    }
    return [
      r.date,
      r.actualDate,
      r.type === "deploy" ? "Instalación" : "Recuperación",
      r.siteId,
      r.siteName,
      r.habitat,
      r.deploymentId,
      r.fieldNotes ?? "",
      statusLabel[r.status] ?? r.status,
      r.lat?.toString() ?? "",
      r.lng?.toString() ?? "",
      utmE,
      utmN,
    ];
  });

  const csvContent = [
    headers.join(","),
    ...csvRows.map((row) =>
      row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(","),
    ),
  ].join("\n");

  const blob = new Blob(["\uFEFF" + csvContent], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `cronograma_biochoco_${new Date().toISOString().split("T")[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function ScheduleTable({
  deploymentsThisMonth,
  retrievalsThisMonth,
  allSchedule,
  sites,
  deployedSet,
  retrievedSet,
  selectedMonth,
  canEditNotes = false,
  onFocusSite,
  onPrevMonth,
  onNextMonth,
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
        header: "Fecha Plan",
        cell: ({ getValue }) => (
          <span className="tabular-nums">{getValue<string>() || "—"}</span>
        ),
      },
      {
        accessorKey: "actualDate",
        header: "Fecha Real",
        cell: ({ getValue }) => {
          const v = getValue<string>();
          if (!v) return <span className="text-muted-foreground">—</span>;
          return <span className="tabular-nums text-green-600">{v}</span>;
        },
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
        cell: ({ getValue }) => getValue<string>(),
      },
      {
        accessorKey: "habitat",
        header: "Hábitat",
        cell: ({ getValue }) => getValue<string>(),
      },
      {
        accessorKey: "deploymentId",
        header: "ID Instalación",
        cell: ({ getValue }) => (
          <span className="font-mono text-xs">{getValue<string>()}</span>
        ),
      },
      {
        id: "fieldNotes",
        header: "Notas",
        cell: ({ row }) => (
          <FieldNotesPopover
            deploymentName={row.original.deploymentId}
            initialNotes={row.original.fieldNotes}
            canEdit={canEditNotes}
          />
        ),
        enableSorting: false,
        enableGlobalFilter: false,
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
        id: "utmEasting",
        header: "UTM Este",
        cell: ({ row }) => {
          const { lat, lng } = row.original;
          if (lat == null || lng == null) return "—";
          const utm = toUtm17N(lat, lng);
          return <span className="tabular-nums">{Math.round(utm.easting)}</span>;
        },
        enableGlobalFilter: false,
      },
      {
        id: "utmNorthing",
        header: "UTM Norte",
        cell: ({ row }) => {
          const { lat, lng } = row.original;
          if (lat == null || lng == null) return "—";
          const utm = toUtm17N(lat, lng);
          return <span className="tabular-nums">{Math.round(utm.northing)}</span>;
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
            <button
              type="button"
              onClick={() => onFocusSite?.(lat, lng)}
              className="inline-flex items-center gap-1 text-blue-600 hover:underline"
            >
              <MapPin className="h-3.5 w-3.5" />
              Ver
            </button>
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
    [canEditNotes, onFocusSite],
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
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {!showAll && (
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onPrevMonth}>
            <ChevronLeft className="h-4 w-4" />
            Anterior
          </Button>
        )}
        <h2 className="text-lg font-semibold">
          {showAll ? "Cronograma — Todo" : `Cronograma — ${monthLabel}`}
        </h2>
        {!showAll && (
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onNextMonth}>
            Siguiente
            <ChevronRight className="h-4 w-4" />
          </Button>
        )}
        <div className="relative ml-auto w-48">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar..."
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => downloadCsv(table.getFilteredRowModel().rows.map((r) => r.original))}
        >
          <Download className="h-4 w-4 mr-1" />
          CSV
        </Button>
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

        <div className="rounded-xl border overflow-auto">
          <Table className="text-xs w-auto">
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
