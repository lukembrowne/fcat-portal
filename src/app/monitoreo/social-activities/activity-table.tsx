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
  Download,
  Search,
} from "lucide-react";
import type { SocialActivityRecord } from "@/lib/odk-types";

function downloadCsv(activities: SocialActivityRecord[]) {
  const headers = [
    "Fecha",
    "Tema",
    "Tipo de Evento",
    "Área(s) de Desarrollo",
    "Lugar",
    "Institución Organizadora",
    "Capacitadores",
    "Tipo de Participantes",
    "Comunidades / Instituciones",
    "Mujeres",
    "Hombres",
    "Niños",
    "Adolescentes",
    "Otros",
    "Total Participantes",
    "Proyecto(s) FCAT",
    "Encuestador",
  ];

  const rows = activities.map((a) => [
    a.fecha ?? "",
    a.temaEvento,
    a.tipoEventoLabel,
    a.areasDesarrolloLabels.join(", "),
    a.lugarEventoLabel,
    a.institucionOrganizadora,
    a.nombreCapacitadores,
    a.tipoParticipantesLabels.join(", "),
    a.comunidadesInstituciones,
    a.numMujeres.toString(),
    a.numHombres.toString(),
    a.numNinos.toString(),
    a.numAdolescentes.toString(),
    a.numOtros.toString(),
    a.totalParticipantes.toString(),
    a.proyectosFcatLabels.join(", "),
    a.nombreEncuestador,
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
  a.download = `actividades_sociales_${new Date().toISOString().split("T")[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

interface ActivityTableProps {
  activities: SocialActivityRecord[];
  onViewPhotos: (activity: SocialActivityRecord) => void;
}

export function ActivityTable({ activities, onViewPhotos }: ActivityTableProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 50,
  });

  const columns = useMemo<ColumnDef<SocialActivityRecord>[]>(
    () => [
      {
        id: "photos",
        header: "",
        cell: ({ row }) => {
          const a = row.original;
          if (!a.hasPhotos) return null;
          return (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 gap-1"
              onClick={() => onViewPhotos(a)}
            >
              <Camera className="h-4 w-4" />
            </Button>
          );
        },
        enableSorting: false,
        enableGlobalFilter: false,
        size: 50,
      },
      {
        accessorKey: "fecha",
        header: "Fecha",
        cell: ({ getValue }) => getValue<string | null>() ?? "—",
      },
      {
        accessorKey: "temaEvento",
        header: "Tema",
        cell: ({ getValue }) => {
          const val = getValue<string>();
          return (
            <span className="line-clamp-2 max-w-[200px]" title={val}>
              {val || "—"}
            </span>
          );
        },
      },
      {
        accessorKey: "tipoEventoLabel",
        header: "Tipo",
      },
      {
        accessorKey: "areasDesarrolloLabels",
        header: "Área(s)",
        cell: ({ getValue }) => {
          const labels = getValue<string[]>();
          return (
            <span className="text-xs" title={labels.join(", ")}>
              {labels.join(", ") || "—"}
            </span>
          );
        },
        enableSorting: false,
      },
      {
        accessorKey: "lugarEventoLabel",
        header: "Lugar",
      },
      {
        accessorKey: "institucionOrganizadora",
        header: "Institución",
        cell: ({ getValue }) => {
          const val = getValue<string>();
          return (
            <span className="text-xs line-clamp-1 max-w-[160px]" title={val}>
              {val || "—"}
            </span>
          );
        },
      },
      {
        accessorKey: "nombreCapacitadores",
        header: "Capacitadores",
        cell: ({ getValue }) => {
          const val = getValue<string>();
          return (
            <span className="text-xs line-clamp-1 max-w-[160px]" title={val}>
              {val || "—"}
            </span>
          );
        },
      },
      {
        accessorKey: "tipoParticipantesLabels",
        header: "Tipo Participantes",
        cell: ({ getValue }) => {
          const labels = getValue<string[]>();
          return (
            <span className="text-xs line-clamp-1" title={labels.join(", ")}>
              {labels.join(", ") || "—"}
            </span>
          );
        },
        enableSorting: false,
      },
      {
        accessorKey: "comunidadesInstituciones",
        header: "Comunidades",
        cell: ({ getValue }) => {
          const val = getValue<string>();
          return (
            <span className="text-xs line-clamp-1 max-w-[180px]" title={val}>
              {val || "—"}
            </span>
          );
        },
      },
      {
        accessorKey: "totalParticipantes",
        header: "Total",
        cell: ({ getValue }) => (
          <span className="tabular-nums font-medium">
            {getValue<number>()}
          </span>
        ),
      },
      {
        id: "demographics",
        header: "M / H / N / A",
        cell: ({ row }) => {
          const a = row.original;
          return (
            <span className="tabular-nums text-xs whitespace-nowrap">
              {a.numMujeres}M / {a.numHombres}H / {a.numNinos}N / {a.numAdolescentes}A
            </span>
          );
        },
        enableSorting: false,
        enableGlobalFilter: false,
      },
      {
        accessorKey: "proyectosFcatLabels",
        header: "Proyecto(s)",
        cell: ({ getValue }) => {
          const labels = getValue<string[]>();
          return (
            <span className="text-xs line-clamp-1" title={labels.join(", ")}>
              {labels.join(", ") || "—"}
            </span>
          );
        },
        enableSorting: false,
      },
      {
        accessorKey: "nombreEncuestador",
        header: "Encuestador",
        cell: ({ getValue }) => {
          const val = getValue<string>();
          return (
            <span className="text-xs whitespace-nowrap">
              {val || "—"}
            </span>
          );
        },
      },
    ],
    [onViewPhotos]
  );

  const table = useReactTable({
    data: activities,
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
        <Button
          variant="outline"
          size="sm"
          onClick={() => downloadCsv(activities)}
        >
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
                  No hay actividades registradas
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
          {table.getFilteredRowModel().rows.length} actividades
          {globalFilter && " (filtradas)"}
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
